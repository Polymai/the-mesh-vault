package __POLYMAI_PACKAGE__;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Iterator;
import java.util.List;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

import net.i2p.crypto.eddsa.EdDSAEngine;
import net.i2p.crypto.eddsa.EdDSAPrivateKey;
import net.i2p.crypto.eddsa.EdDSAPublicKey;
import net.i2p.crypto.eddsa.spec.EdDSANamedCurveSpec;
import net.i2p.crypto.eddsa.spec.EdDSANamedCurveTable;
import net.i2p.crypto.eddsa.spec.EdDSAPrivateKeySpec;
import net.i2p.crypto.eddsa.spec.EdDSAPublicKeySpec;

final class PolymaiAppMeshCrypto {
    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String SECRET_ALIAS = "themeshvault-native-node-secrets-v1";
    private static final String IDENTITY_KEY = "device_identity_seed";
    private static final SecureRandom RANDOM = new SecureRandom();

    private PolymaiAppMeshCrypto() {}

    static String hashHex(byte[] value) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(value);
        StringBuilder output = new StringBuilder(digest.length * 2);
        for (byte item : digest) output.append(String.format("%02x", item & 0xff));
        return output.toString();
    }

    static String hashHex(String value) throws Exception {
        return hashHex(value.getBytes(StandardCharsets.UTF_8));
    }

    static String base64Url(byte[] value) {
        return Base64.encodeToString(value, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
    }

    static byte[] base64UrlDecode(String value) {
        return Base64.decode(value, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
    }

    static String canonical(Object value) throws Exception {
        if (value == null || value == JSONObject.NULL) return "null";
        if (value instanceof JSONObject) {
            JSONObject object = (JSONObject) value;
            List<String> keys = new ArrayList<>();
            Iterator<String> iterator = object.keys();
            while (iterator.hasNext()) keys.add(iterator.next());
            Collections.sort(keys);
            StringBuilder output = new StringBuilder("{");
            for (int index = 0; index < keys.size(); index++) {
                if (index > 0) output.append(',');
                String key = keys.get(index);
                output.append(JSONObject.quote(key)).append(':').append(canonical(object.get(key)));
            }
            return output.append('}').toString();
        }
        if (value instanceof JSONArray) {
            JSONArray array = (JSONArray) value;
            StringBuilder output = new StringBuilder("[");
            for (int index = 0; index < array.length(); index++) {
                if (index > 0) output.append(',');
                output.append(canonical(array.get(index)));
            }
            return output.append(']').toString();
        }
        if (value instanceof String) return JSONObject.quote((String) value);
        if (value instanceof Number) return JSONObject.numberToString((Number) value);
        if (value instanceof Boolean) return value.toString();
        return JSONObject.quote(String.valueOf(value));
    }

    static JSONObject without(JSONObject source, String... excluded) throws Exception {
        JSONObject copy = new JSONObject(source.toString());
        for (String key : excluded) copy.remove(key);
        return copy;
    }

    static Identity loadOrCreateIdentity(Context context) throws Exception {
        SecurePreferences secrets = new SecurePreferences(context);
        String encodedSeed = secrets.get(IDENTITY_KEY);
        byte[] seed;
        if (encodedSeed == null || encodedSeed.isEmpty()) {
            seed = new byte[32];
            RANDOM.nextBytes(seed);
            secrets.put(IDENTITY_KEY, base64Url(seed));
        } else {
            seed = base64UrlDecode(encodedSeed);
        }
        if (seed.length != 32) throw new IllegalStateException("The native device identity is malformed.");
        try {
            EdDSANamedCurveSpec spec = EdDSANamedCurveTable.getByName("Ed25519");
            EdDSAPrivateKeySpec privateSpec = new EdDSAPrivateKeySpec(seed, spec);
            EdDSAPrivateKey privateKey = new EdDSAPrivateKey(privateSpec);
            EdDSAPublicKey publicKey = new EdDSAPublicKey(new EdDSAPublicKeySpec(privateSpec.getA(), spec));
            return new Identity(privateKey, publicKey, base64Url(publicKey.getAbyte()));
        } finally {
            java.util.Arrays.fill(seed, (byte) 0);
        }
    }

    static boolean verifyControlObject(JSONObject object, long now) {
        try {
            if (object.optInt("protocolVersion", 0) != 3) return false;
            String kind = object.optString("kind", "");
            String lookupKey = object.optString("lookupKey", "");
            String objectId = object.optString("objectId", "");
            String payloadHash = object.optString("payloadHash", "");
            String publicKey = object.optString("senderPublicKey", "");
            String signature = object.optString("signature", "");
            long createdAt = object.optLong("createdAt", 0);
            long expiresAt = object.optLong("expiresAt", 0);
            if (kind.isEmpty() || lookupKey.isEmpty() || createdAt > now + 300000L || expiresAt <= now || expiresAt - createdAt > 2678400000L) return false;
            if (!hashHex(canonical(object.opt("payload"))).equals(payloadHash)) return false;
            JSONObject core = without(object, "signature", "objectId", "storedAt", "lastAccessedAt", "sizeBytes", "replicaNodeIds", "semanticKey", "retentionGroup");
            JSONObject identified = new JSONObject(core.toString()).put("signature", signature);
            if (!hashHex(canonical(identified)).equals(objectId)) return false;
            return verify(publicKey, signature, canonical(core).getBytes(StandardCharsets.UTF_8));
        } catch (Exception ignored) {
            return false;
        }
    }

    static boolean verify(String encodedPublicKey, String encodedSignature, byte[] message) {
        try {
            byte[] rawPublic = base64UrlDecode(encodedPublicKey);
            byte[] rawSignature = base64UrlDecode(encodedSignature);
            if (rawPublic.length != 32 || rawSignature.length != 64) return false;
            EdDSANamedCurveSpec spec = EdDSANamedCurveTable.getByName("Ed25519");
            EdDSAPublicKey key = new EdDSAPublicKey(new EdDSAPublicKeySpec(rawPublic, spec));
            EdDSAEngine engine = new EdDSAEngine(MessageDigest.getInstance(spec.getHashAlgorithm()));
            engine.initVerify(key);
            engine.update(message);
            return engine.verify(rawSignature);
        } catch (Exception ignored) {
            return false;
        }
    }

    static final class Identity {
        private final EdDSAPrivateKey privateKey;
        final EdDSAPublicKey publicKey;
        final String encodedPublicKey;

        Identity(EdDSAPrivateKey privateKey, EdDSAPublicKey publicKey, String encodedPublicKey) {
            this.privateKey = privateKey;
            this.publicKey = publicKey;
            this.encodedPublicKey = encodedPublicKey;
        }

        String sign(byte[] message) throws Exception {
            EdDSANamedCurveSpec spec = EdDSANamedCurveTable.getByName("Ed25519");
            EdDSAEngine engine = new EdDSAEngine(MessageDigest.getInstance(spec.getHashAlgorithm()));
            engine.initSign(privateKey);
            engine.update(message);
            return base64Url(engine.sign());
        }
    }

    static final class SecurePreferences {
        private final SharedPreferences preferences;

        SecurePreferences(Context context) {
            preferences = context.getSharedPreferences("themeshvault_native_node_secrets", Context.MODE_PRIVATE);
        }

        synchronized void put(String name, String value) throws Exception {
            if (value == null) {
                preferences.edit().remove(name).apply();
                return;
            }
            SecretKey key = secretKey();
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key);
            byte[] encrypted = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
            byte[] envelope = new byte[1 + cipher.getIV().length + encrypted.length];
            envelope[0] = (byte) cipher.getIV().length;
            System.arraycopy(cipher.getIV(), 0, envelope, 1, cipher.getIV().length);
            System.arraycopy(encrypted, 0, envelope, 1 + cipher.getIV().length, encrypted.length);
            preferences.edit().putString(name, Base64.encodeToString(envelope, Base64.NO_WRAP)).apply();
        }

        synchronized String get(String name) throws Exception {
            String encoded = preferences.getString(name, null);
            if (encoded == null) return null;
            byte[] envelope = Base64.decode(encoded, Base64.NO_WRAP);
            int ivLength = envelope.length == 0 ? 0 : envelope[0] & 0xff;
            if (ivLength != 12 || envelope.length <= 1 + ivLength) return null;
            byte[] iv = java.util.Arrays.copyOfRange(envelope, 1, 1 + ivLength);
            byte[] encrypted = java.util.Arrays.copyOfRange(envelope, 1 + ivLength, envelope.length);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, secretKey(), new GCMParameterSpec(128, iv));
            return new String(cipher.doFinal(encrypted), StandardCharsets.UTF_8);
        }

        private SecretKey secretKey() throws Exception {
            KeyStore store = KeyStore.getInstance(KEYSTORE);
            store.load(null);
            java.security.Key existing = store.getKey(SECRET_ALIAS, null);
            if (existing instanceof SecretKey) return (SecretKey) existing;
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
            generator.init(new KeyGenParameterSpec.Builder(
                SECRET_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
            ).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
            return generator.generateKey();
        }
    }
}
