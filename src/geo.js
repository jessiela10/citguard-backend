// Perhitungan jarak untuk geofence dan deteksi deviasi rute.
const R = 6371000; // jari-jari bumi (meter)
const toRad = (deg) => (deg * Math.PI) / 180;

// Jarak dua titik koordinat (meter), rumus haversine
function haversine(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Jarak titik P ke ruas garis A-B (meter).
// Koordinat diproyeksikan ke bidang datar di sekitar P (akurat untuk jarak beberapa km).
function pointToSegment(p, a, b) {
  const cosLat = Math.cos(toRad(p.lat));
  const x = (lon) => toRad(lon - p.lon) * cosLat * R;
  const y = (lat) => toRad(lat - p.lat) * R;

  const ax = x(a.lon), ay = y(a.lat);
  const bx = x(b.lon), by = y(b.lat);
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;

  // Titik terdekat di ruas A-B terhadap P (P berada di titik 0,0)
  let t = len2 === 0 ? 0 : -(ax * dx + ay * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

// Jarak terdekat titik P ke rute (daftar titik berurutan). null jika rute kosong.
function distanceToRoute(p, points) {
  if (points.length === 0) return null;
  if (points.length === 1) return haversine(p.lat, p.lon, points[0].lat, points[0].lon);

  let min = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    min = Math.min(min, pointToSegment(p, points[i], points[i + 1]));
  }
  return min;
}

module.exports = { haversine, distanceToRoute };
