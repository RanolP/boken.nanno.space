import * as THREE from "three";

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const q = new THREE.Quaternion();
const one = new THREE.Vector3(1, 1, 1);

/**
 * Road-view floating sign as a yaw-only billboard: its local +z turns about world Y toward the walker, built from the
 * sign-to-walker vector and written as the matrix T(at) * R. drei's <Billboard lockX lockZ> copied the camera's turn
 * instead and, keeping only the XYZ-Euler y of it, folded every heading past 90deg back, showing the sign's back when
 * facing south.
 */
export const faceWalker = (g: THREE.Object3D, at: THREE.Vector3, cam: THREE.Vector3) => {
  const dx = cam.x - at.x;
  const dz = cam.z - at.z;
  if (dx * dx + dz * dz < 1e-12) return;
  g.matrix.compose(at, q.setFromAxisAngle(Y_AXIS, Math.atan2(dx, dz)), one);
  g.matrixWorldNeedsUpdate = true;
};
