-- =====================================================================
-- CIT Guard - Skema Database (MariaDB / MySQL di XAMPP)
-- Import file ini di phpMyAdmin (tab Import) tanpa memilih database dulu.
-- =====================================================================

CREATE DATABASE IF NOT EXISTS citguard
    CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE citguard;

-- ---------------------------------------------------------------------
-- 1. DATA MASTER
-- ---------------------------------------------------------------------

-- Perangkat IoT (ESP32) yang terpasang di kendaraan
CREATE TABLE devices (
    device_id      VARCHAR(32)  NOT NULL PRIMARY KEY,      -- contoh: 'CIT-001'
    name           VARCHAR(100) NOT NULL,
    vehicle_plate  VARCHAR(20),
    status         ENUM('online', 'offline') NOT NULL DEFAULT 'offline',
    last_seen      DATETIME(3),
    created_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;

-- Petugas (driver, pengawal, custodian) yang memakai kartu RFID
CREATE TABLE officers (
    officer_id  INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
    rfid_uid    VARCHAR(32)  NOT NULL UNIQUE,
    name        VARCHAR(100) NOT NULL,
    role        ENUM('driver', 'guard', 'custodian') NOT NULL,
    active      BOOLEAN      NOT NULL DEFAULT TRUE
) ENGINE=InnoDB;

-- Kantong kas yang diberi tag RFID
CREATE TABLE cash_bags (
    bag_id    INT         NOT NULL AUTO_INCREMENT PRIMARY KEY,
    rfid_uid  VARCHAR(32) NOT NULL UNIQUE,
    label     VARCHAR(50) NOT NULL,
    active    BOOLEAN     NOT NULL DEFAULT TRUE
) ENGINE=InnoDB;

-- Lokasi resmi: ATM, cabang, Bank Indonesia, pool kendaraan
CREATE TABLE locations (
    location_id  INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
    name         VARCHAR(100) NOT NULL,
    type         ENUM('atm', 'branch', 'bi', 'depot') NOT NULL,
    lat          DOUBLE       NOT NULL,
    lon          DOUBLE       NOT NULL,
    radius_m     INT          NOT NULL DEFAULT 50      -- radius geofence (meter)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- 2. RENCANA PERJALANAN
-- ---------------------------------------------------------------------

CREATE TABLE trips (
    trip_id            VARCHAR(32) NOT NULL PRIMARY KEY,   -- contoh: 'TRK-001'
    device_id          VARCHAR(32) NOT NULL,
    status             ENUM('planned', 'active', 'completed', 'cancelled') NOT NULL DEFAULT 'planned',
    route_tolerance_m  INT         NOT NULL DEFAULT 100,   -- batas jarak dari rute sebelum dianggap deviasi
    planned_start      DATETIME(3),
    started_at         DATETIME(3),
    ended_at           DATETIME(3),
    created_at         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    FOREIGN KEY (device_id) REFERENCES devices(device_id),
    INDEX trips_device_status (device_id, status)
) ENGINE=InnoDB;

-- Petugas yang ditugaskan pada trip
CREATE TABLE trip_officers (
    trip_id     VARCHAR(32) NOT NULL,
    officer_id  INT         NOT NULL,
    PRIMARY KEY (trip_id, officer_id),
    FOREIGN KEY (trip_id)    REFERENCES trips(trip_id) ON DELETE CASCADE,
    FOREIGN KEY (officer_id) REFERENCES officers(officer_id)
) ENGINE=InnoDB;

-- Titik pemberhentian (ATM/cabang) secara berurutan
CREATE TABLE trip_stops (
    trip_id       VARCHAR(32) NOT NULL,
    stop_order    INT         NOT NULL,
    location_id   INT         NOT NULL,
    planned_bags  INT         NOT NULL DEFAULT 0,  -- jumlah kantong yang diserahkan/diambil
    arrived_at    DATETIME(3),
    departed_at   DATETIME(3),
    PRIMARY KEY (trip_id, stop_order),
    FOREIGN KEY (trip_id)     REFERENCES trips(trip_id) ON DELETE CASCADE,
    FOREIGN KEY (location_id) REFERENCES locations(location_id)
) ENGINE=InnoDB;

-- Titik-titik jalur rute yang direncanakan (untuk deteksi deviasi)
CREATE TABLE trip_route_points (
    trip_id      VARCHAR(32) NOT NULL,
    point_order  INT         NOT NULL,
    lat          DOUBLE      NOT NULL,
    lon          DOUBLE      NOT NULL,
    PRIMARY KEY (trip_id, point_order),
    FOREIGN KEY (trip_id) REFERENCES trips(trip_id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- 3. DATA DARI PERANGKAT (diisi oleh backend dari MQTT)
-- ---------------------------------------------------------------------

-- Telemetri berkala (posisi, kecepatan, status pintu)
CREATE TABLE telemetry (
    id           BIGINT      NOT NULL AUTO_INCREMENT PRIMARY KEY,
    device_id    VARCHAR(32) NOT NULL,
    trip_id      VARCHAR(32),
    seq          BIGINT      NOT NULL,
    device_ts    DATETIME(3) NOT NULL,                   -- waktu dari ESP32
    received_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),  -- waktu diterima server
    lat          DOUBLE,
    lon          DOUBLE,
    speed_kmh    FLOAT,
    gps_source   ENUM('real', 'sim'),
    doors        JSON,                                   -- contoh: [0,0,1] -> pintu 3 terbuka
    shock        BOOLEAN     NOT NULL DEFAULT FALSE,
    buffered     BOOLEAN     NOT NULL DEFAULT FALSE,     -- TRUE = kiriman ulang dari microSD
    raw          JSON        NOT NULL,                   -- payload asli untuk audit
    -- mencegah data ganda saat ESP32 mengirim ulang buffer
    UNIQUE KEY telemetry_no_duplicate (device_id, seq, device_ts),
    INDEX telemetry_device_time (device_id, device_ts),
    FOREIGN KEY (device_id) REFERENCES devices(device_id),
    FOREIGN KEY (trip_id)   REFERENCES trips(trip_id)
) ENGINE=InnoDB;

-- Kejadian penting dari perangkat
CREATE TABLE events (
    id           BIGINT      NOT NULL AUTO_INCREMENT PRIMARY KEY,
    device_id    VARCHAR(32) NOT NULL,
    trip_id      VARCHAR(32),
    seq          BIGINT      NOT NULL,
    device_ts    DATETIME(3) NOT NULL,
    received_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    type         ENUM('rfid', 'door_open', 'door_close', 'panic', 'tamper', 'shock') NOT NULL,
    door         SMALLINT,                               -- untuk door_open / door_close
    rfid_uid     VARCHAR(32),                            -- untuk rfid
    buffered     BOOLEAN     NOT NULL DEFAULT FALSE,
    raw          JSON        NOT NULL,
    UNIQUE KEY events_no_duplicate (device_id, seq, device_ts),
    INDEX events_device_time (device_id, device_ts),
    FOREIGN KEY (device_id) REFERENCES devices(device_id),
    FOREIGN KEY (trip_id)   REFERENCES trips(trip_id)
) ENGINE=InnoDB;

-- Riwayat online/offline perangkat (dari pesan status & Last Will)
CREATE TABLE device_status_log (
    id           BIGINT      NOT NULL AUTO_INCREMENT PRIMARY KEY,
    device_id    VARCHAR(32) NOT NULL,
    status       ENUM('online', 'offline') NOT NULL,
    received_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    FOREIGN KEY (device_id) REFERENCES devices(device_id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- 4. HASIL PENGOLAHAN BACKEND (diisi di tahap event engine)
-- ---------------------------------------------------------------------

CREATE TABLE alerts (
    id               BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
    device_id        VARCHAR(32)  NOT NULL,
    trip_id          VARCHAR(32),
    event_id         BIGINT,
    type             VARCHAR(30)  NOT NULL,   -- route_deviation, unauthorized_door, panic, tamper, offline, ...
    severity         ENUM('info', 'warning', 'critical') NOT NULL,
    message          VARCHAR(255) NOT NULL,
    status           ENUM('open', 'acknowledged', 'resolved') NOT NULL DEFAULT 'open',
    acknowledged_by  VARCHAR(100),
    acknowledged_at  DATETIME(3),
    created_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX alerts_open (status, created_at),
    FOREIGN KEY (device_id) REFERENCES devices(device_id),
    FOREIGN KEY (trip_id)   REFERENCES trips(trip_id),
    FOREIGN KEY (event_id)  REFERENCES events(id)
) ENGINE=InnoDB;

-- Jejak audit: setiap baris menyimpan hash baris sebelumnya (hash chain)
CREATE TABLE audit_log (
    id          BIGINT      NOT NULL AUTO_INCREMENT PRIMARY KEY,
    entity      VARCHAR(30) NOT NULL,   -- 'event', 'alert', 'trip', ...
    entity_id   VARCHAR(64) NOT NULL,
    action      VARCHAR(30) NOT NULL,
    data        JSON        NOT NULL,
    prev_hash   CHAR(64),
    hash        CHAR(64)    NOT NULL,
    created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;

-- audit_log tidak boleh diubah atau dihapus
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
    FOR EACH ROW SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'audit_log bersifat immutable: UPDATE tidak diizinkan';

CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
    FOR EACH ROW SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'audit_log bersifat immutable: DELETE tidak diizinkan';
