-- =====================================================================
-- CIT Guard - Data contoh untuk pengujian (MariaDB / MySQL)
-- Import setelah schema.sql.
-- =====================================================================

USE citguard;

INSERT INTO devices (device_id, name, vehicle_plate) VALUES
    ('CIT-001', 'Unit Kendaraan Model 1', 'B 1234 CIT');

INSERT INTO officers (rfid_uid, name, role) VALUES
    ('A3F1229C', 'Budi Santoso', 'custodian'),
    ('B47D10E2', 'Andi Pratama', 'driver'),
    ('C9028F31', 'Rizky Hidayat', 'guard');

INSERT INTO cash_bags (rfid_uid, label) VALUES
    ('D1E2F301', 'KANTONG-001'),
    ('D1E2F302', 'KANTONG-002'),
    ('D1E2F303', 'KANTONG-003');

INSERT INTO locations (name, type, lat, lon, radius_m) VALUES
    ('Pool CIT Sudirman',        'depot',  -6.2088, 106.8456, 50),
    ('ATM Bank - Thamrin',       'atm',    -6.1950, 106.8230, 30),
    ('ATM Bank - Monas',         'atm',    -6.1754, 106.8272, 30),
    ('Cabang Bank - Gajah Mada', 'branch', -6.1630, 106.8180, 50);

-- Trip contoh yang sedang aktif untuk CIT-001
INSERT INTO trips (trip_id, device_id, status, planned_start, started_at) VALUES
    ('TRK-001', 'CIT-001', 'active', NOW(3), NOW(3));

INSERT INTO trip_officers (trip_id, officer_id)
    SELECT 'TRK-001', officer_id FROM officers;

INSERT INTO trip_stops (trip_id, stop_order, location_id, planned_bags) VALUES
    ('TRK-001', 1, 2, 1),
    ('TRK-001', 2, 3, 1),
    ('TRK-001', 3, 4, 1);

INSERT INTO trip_route_points (trip_id, point_order, lat, lon) VALUES
    ('TRK-001', 1, -6.2088, 106.8456),
    ('TRK-001', 2, -6.2020, 106.8340),
    ('TRK-001', 3, -6.1950, 106.8230),
    ('TRK-001', 4, -6.1850, 106.8250),
    ('TRK-001', 5, -6.1754, 106.8272),
    ('TRK-001', 6, -6.1690, 106.8220),
    ('TRK-001', 7, -6.1630, 106.8180);
