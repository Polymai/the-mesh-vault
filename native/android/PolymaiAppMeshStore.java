package __POLYMAI_PACKAGE__;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.util.regex.Pattern;

final class PolymaiAppMeshStore extends SQLiteOpenHelper {
    private static final Pattern HASH = Pattern.compile("^[a-f0-9]{64}$");
    private static final long MAX_CONTROL_TTL_MS = 31L * 24L * 60L * 60L * 1000L;
    private final File shardDirectory;
    private long shardLimitBytes;
    private long controlLimitBytes;

    PolymaiAppMeshStore(Context context, long shardLimitBytes, long controlLimitBytes) {
        super(context, "themeshvault-native-node-v1.db", null, 1);
        this.shardDirectory = new File(context.getFilesDir(), "themeshvault-shards-v3");
        this.shardLimitBytes = Math.max(0, shardLimitBytes);
        this.controlLimitBytes = Math.max(25L * 1024L * 1024L, controlLimitBytes);
        if (!shardDirectory.exists() && !shardDirectory.mkdirs()) throw new IllegalStateException("Could not create native shard storage.");
    }

    @Override
    public void onCreate(SQLiteDatabase database) {
        database.execSQL("create table shards(hash text primary key,size_bytes integer not null,updated_at integer not null)");
        database.execSQL("create table controls(object_id text primary key,kind text not null,lookup_key text not null,payload text not null,size_bytes integer not null,created_at integer not null,expires_at integer not null,last_accessed_at integer not null)");
        database.execSQL("create index controls_lookup on controls(kind,lookup_key,created_at desc)");
        database.execSQL("create index controls_expiry on controls(expires_at)");
        database.execSQL("create table manifests(manifest_id text primary key,envelope text not null,size_bytes integer not null,created_at integer not null,last_accessed_at integer not null)");
    }

    @Override
    public void onUpgrade(SQLiteDatabase database, int oldVersion, int newVersion) {}

    synchronized void setLimits(long shards, long controls) {
        shardLimitBytes = Math.max(0, shards);
        controlLimitBytes = Math.max(25L * 1024L * 1024L, controls);
        compactControls();
    }

    synchronized void putShard(String hash, byte[] bytes) throws Exception {
        requireHash(hash);
        if (!PolymaiAppMeshCrypto.hashHex(bytes).equals(hash)) throw new SecurityException("Shard hash mismatch.");
        long current = shardBytes();
        long existing = shardSize(hash);
        if (current - existing + bytes.length > shardLimitBytes) throw new IllegalStateException("Native contribution limit reached.");
        File target = shardFile(hash);
        File pending = new File(shardDirectory, hash + ".pending");
        try (FileOutputStream output = new FileOutputStream(pending, false)) {
            output.write(bytes);
            output.getFD().sync();
        }
        if (target.exists() && !target.delete()) throw new IllegalStateException("Could not replace the existing shard.");
        if (!pending.renameTo(target)) {
            pending.delete();
            throw new IllegalStateException("Could not commit the shard.");
        }
        ContentValues values = new ContentValues();
        values.put("hash", hash);
        values.put("size_bytes", bytes.length);
        values.put("updated_at", System.currentTimeMillis());
        getWritableDatabase().insertWithOnConflict("shards", null, values, SQLiteDatabase.CONFLICT_REPLACE);
    }

    synchronized byte[] getShard(String hash) throws Exception {
        requireHash(hash);
        File file = shardFile(hash);
        if (!file.isFile()) {
            getWritableDatabase().delete("shards", "hash=?", new String[] { hash });
            return null;
        }
        if (file.length() > 32L * 1024L * 1024L) return null;
        try (FileInputStream input = new FileInputStream(file); ByteArrayOutputStream output = new ByteArrayOutputStream((int) file.length())) {
            byte[] buffer = new byte[64 * 1024];
            int count;
            while ((count = input.read(buffer)) >= 0) output.write(buffer, 0, count);
            byte[] bytes = output.toByteArray();
            if (!PolymaiAppMeshCrypto.hashHex(bytes).equals(hash)) {
                deleteShard(hash);
                return null;
            }
            return bytes;
        }
    }

    synchronized boolean deleteShard(String hash) {
        requireHash(hash);
        File file = shardFile(hash);
        boolean deleted = !file.exists() || file.delete();
        if (deleted) getWritableDatabase().delete("shards", "hash=?", new String[] { hash });
        return deleted;
    }

    synchronized long clearShards() {
        long count = count("shards");
        File[] files = shardDirectory.listFiles();
        if (files != null) for (File file : files) {
            if ((file.getName().endsWith(".shard") || file.getName().endsWith(".pending")) && !file.delete()) {
                throw new IllegalStateException("Could not remove every native shard file.");
            }
        }
        getWritableDatabase().delete("shards", null, null);
        return count;
    }

    synchronized boolean putControl(JSONObject object) {
        String encoded = object.toString();
        if (encoded.getBytes(java.nio.charset.StandardCharsets.UTF_8).length > 4 * 1024 * 1024) return false;
        long now = System.currentTimeMillis();
        if (!PolymaiAppMeshCrypto.verifyControlObject(object, now)) return false;
        long expiresAt = object.optLong("expiresAt", 0);
        if (expiresAt <= now || expiresAt - now > MAX_CONTROL_TTL_MS) return false;
        String semantic = controlSemanticKey(object);
        long createdAt = object.optLong("createdAt", now);
        try (Cursor cursor = getReadableDatabase().query(
            "controls", new String[] { "object_id", "payload", "created_at" }, "kind=? and lookup_key=?",
            new String[] { object.optString("kind"), object.optString("lookupKey") }, null, null, null
        )) {
            while (cursor.moveToNext()) {
                JSONObject existing = new JSONObject(cursor.getString(1));
                if (!semantic.equals(controlSemanticKey(existing))) continue;
                long existingCreated = cursor.getLong(2);
                String existingId = cursor.getString(0);
                if (existingCreated > createdAt || (existingCreated == createdAt && existingId.compareTo(object.optString("objectId")) > 0)) return true;
                getWritableDatabase().delete("controls", "object_id=?", new String[] { existingId });
            }
        } catch (Exception ignored) {}
        ContentValues values = new ContentValues();
        values.put("object_id", object.optString("objectId"));
        values.put("kind", object.optString("kind"));
        values.put("lookup_key", object.optString("lookupKey"));
        values.put("payload", encoded);
        values.put("size_bytes", encoded.getBytes(java.nio.charset.StandardCharsets.UTF_8).length);
        values.put("created_at", createdAt);
        values.put("expires_at", expiresAt);
        values.put("last_accessed_at", now);
        long result = getWritableDatabase().insertWithOnConflict("controls", null, values, SQLiteDatabase.CONFLICT_REPLACE);
        int groupLimit = controlGroupLimit(object.optString("kind"));
        getWritableDatabase().execSQL(
            "delete from controls where rowid in (select rowid from controls where kind=? and lookup_key=? order by created_at desc,object_id desc limit -1 offset ?)",
            new Object[] { object.optString("kind"), object.optString("lookupKey"), groupLimit }
        );
        getWritableDatabase().execSQL("delete from controls where rowid in (select rowid from controls order by created_at desc,object_id desc limit -1 offset 4096)");
        compactControls();
        return result >= 0;
    }

    private static int controlGroupLimit(String kind) {
        if ("peer".equals(kind)) return 512;
        if ("fragment-location".equals(kind)) return 24;
        if ("manifest".equals(kind)) return 3;
        if ("vault-index".equals(kind)) return 5;
        if ("repair-lease".equals(kind)) return 32;
        if ("anchor-handoff".equals(kind)) return 1;
        return 512;
    }

    private static String controlSemanticKey(JSONObject object) {
        JSONObject payload = object.optJSONObject("payload");
        if (payload == null) payload = new JSONObject();
        String kind = object.optString("kind");
        String lookup = object.optString("lookupKey");
        String sender = object.optString("senderPublicKey");
        String identity;
        if ("peer".equals(kind)) identity = payload.optString("nodeId", sender);
        else if ("fragment-location".equals(kind)) identity = lookup + ":" + payload.optString("nodeId", sender);
        else if ("manifest".equals(kind)) identity = lookup + ":" + payload.optString("manifestHash", object.optString("payloadHash"));
        else if ("vault-index".equals(kind)) identity = lookup + ":" + payload.optString("revision", "unknown") + ":" + payload.optString("indexHash", object.optString("payloadHash"));
        else if ("oplog".equals(kind)) identity = lookup + ":" + payload.optString("opId", object.optString("payloadHash"));
        else if ("repair-request".equals(kind) || "repair-complete".equals(kind)) identity = payload.optString("requestId", object.optString("payloadHash"));
        else if ("repair-lease".equals(kind)) identity = payload.optString("leaseId", payload.optString("requestId", lookup) + ":" + payload.optString("workerNodeId", sender));
        else if ("deletion-order".equals(kind) || "deletion-ack".equals(kind)) identity = payload.optString("orderId", payload.optString("placementId", object.optString("payloadHash"))) + ":" + payload.optString("nodeId", sender);
        else identity = payload.optString("nodeId", object.optString("payloadHash"));
        return kind + "\u0000" + identity;
    }

    synchronized JSONArray queryControls(String kind, String lookupKey, int requestedLimit) {
        purgeExpired();
        int limit = Math.max(1, Math.min(20, requestedLimit));
        JSONArray result = new JSONArray();
        try (Cursor cursor = getReadableDatabase().query(
            "controls", new String[] { "object_id", "payload" }, "kind=? and lookup_key=?",
            new String[] { kind, lookupKey }, null, null, "created_at desc", String.valueOf(limit)
        )) {
            while (cursor.moveToNext()) {
                try {
                    JSONObject object = new JSONObject(cursor.getString(1));
                    if (!PolymaiAppMeshCrypto.verifyControlObject(object, System.currentTimeMillis())) continue;
                    result.put(object);
                    ContentValues touch = new ContentValues();
                    touch.put("last_accessed_at", System.currentTimeMillis());
                    getWritableDatabase().update("controls", touch, "object_id=?", new String[] { cursor.getString(0) });
                } catch (Exception ignored) {}
            }
        }
        return result;
    }

    synchronized boolean putManifest(String manifestId, JSONObject envelope) {
        if (!HASH.matcher(manifestId).matches() || !manifestId.equals(envelope.optString("manifestId"))) return false;
        String encoded = envelope.toString();
        int size = encoded.getBytes(java.nio.charset.StandardCharsets.UTF_8).length;
        if (size > 4 * 1024 * 1024 || envelope.optInt("manifestFormatVersion", 0) != 3 || envelope.optInt("storageProtocolVersion", 0) != 3) return false;
        try {
            JSONObject signable = PolymaiAppMeshCrypto.without(envelope, "manifestId", "signature");
            String signature = envelope.optString("signature", "");
            String owner = envelope.optString("ownerPublicKey", "");
            if (!PolymaiAppMeshCrypto.hashHex(PolymaiAppMeshCrypto.base64UrlDecode(owner)).equals(envelope.optString("vaultId", ""))) return false;
            if (!PolymaiAppMeshCrypto.verify(owner, signature, PolymaiAppMeshCrypto.canonical(signable).getBytes(java.nio.charset.StandardCharsets.UTF_8))) return false;
            JSONObject identified = new JSONObject(signable.toString()).put("signature", signature);
            if (!PolymaiAppMeshCrypto.hashHex(PolymaiAppMeshCrypto.canonical(identified)).equals(manifestId)) return false;
        } catch (Exception error) {
            return false;
        }
        ContentValues values = new ContentValues();
        values.put("manifest_id", manifestId);
        values.put("envelope", encoded);
        values.put("size_bytes", size);
        values.put("created_at", envelope.optLong("createdAt", System.currentTimeMillis()));
        values.put("last_accessed_at", System.currentTimeMillis());
        getWritableDatabase().insertWithOnConflict("manifests", null, values, SQLiteDatabase.CONFLICT_REPLACE);
        compactControls();
        return true;
    }

    synchronized JSONObject getManifest(String manifestId) {
        if (!HASH.matcher(manifestId).matches()) return null;
        try (Cursor cursor = getReadableDatabase().query("manifests", new String[] { "envelope" }, "manifest_id=?", new String[] { manifestId }, null, null, null, "1")) {
            if (!cursor.moveToFirst()) return null;
            ContentValues touch = new ContentValues();
            touch.put("last_accessed_at", System.currentTimeMillis());
            getWritableDatabase().update("manifests", touch, "manifest_id=?", new String[] { manifestId });
            return new JSONObject(cursor.getString(0));
        } catch (Exception ignored) {
            return null;
        }
    }

    synchronized Stats stats() {
        purgeExpired();
        return new Stats(count("shards"), shardBytes(), count("controls"), controlBytes(), count("manifests"));
    }

    private void compactControls() {
        purgeExpired();
        while (controlBytes() > controlLimitBytes) {
            try (Cursor cursor = getReadableDatabase().rawQuery(
                "select kind,id from (select 'control' kind,rowid id,last_accessed_at from controls union all select 'manifest' kind,rowid id,last_accessed_at from manifests) order by last_accessed_at asc limit 1",
                null
            )) {
                if (!cursor.moveToFirst()) break;
                String table = "control".equals(cursor.getString(0)) ? "controls" : "manifests";
                getWritableDatabase().delete(table, "rowid=?", new String[] { String.valueOf(cursor.getLong(1)) });
            }
        }
    }

    private void purgeExpired() {
        getWritableDatabase().delete("controls", "expires_at<=?", new String[] { String.valueOf(System.currentTimeMillis()) });
    }

    private long shardSize(String hash) {
        try (Cursor cursor = getReadableDatabase().rawQuery("select coalesce(size_bytes,0) from shards where hash=?", new String[] { hash })) {
            return cursor.moveToFirst() ? cursor.getLong(0) : 0;
        }
    }

    private long shardBytes() { return scalar("select coalesce(sum(size_bytes),0) from shards"); }
    private long controlBytes() { return scalar("select coalesce((select sum(size_bytes) from controls),0)+coalesce((select sum(size_bytes) from manifests),0)"); }
    private long count(String table) { return scalar("select count(*) from " + table); }
    private long scalar(String sql) {
        try (Cursor cursor = getReadableDatabase().rawQuery(sql, null)) { return cursor.moveToFirst() ? cursor.getLong(0) : 0; }
    }
    private File shardFile(String hash) { return new File(shardDirectory, hash + ".shard"); }
    private static void requireHash(String hash) { if (hash == null || !HASH.matcher(hash).matches()) throw new IllegalArgumentException("Invalid shard hash."); }

    static final class Stats {
        final long shardCount;
        final long shardBytes;
        final long controlCount;
        final long controlBytes;
        final long manifestCount;

        Stats(long shardCount, long shardBytes, long controlCount, long controlBytes, long manifestCount) {
            this.shardCount = shardCount;
            this.shardBytes = shardBytes;
            this.controlCount = controlCount;
            this.controlBytes = controlBytes;
            this.manifestCount = manifestCount;
        }
    }
}
