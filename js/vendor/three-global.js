// Bridges the locally vendored Three.js ES module onto window.THREE before
// globe.gl.min.js (a classic, non-module script) evaluates. globe.gl checks
// window.THREE at load time and, when present, reuses it instead of its own
// bundled minimal stub - this lets the "Data locations" globe use a real
// Three.js scene/material/camera for its dark-sphere, cyan-outline look.
import * as THREE from "./three.module.js";
window.THREE = THREE;
