<?php
/**
 * FaceTube - Production Database Configuration
 * Hostinger MySQL Connection with PDO & Prepared Statements
 * Compatible with Hostinger phpMyAdmin (MySQL 5.7+ / 8.0+ / MariaDB)
 */

require_once __DIR__ . '/../response.php';

// Load .env variables if present in project root, parent directory, or /api/.env
function loadEnvFile($path) {
    if (!file_exists($path) || !is_readable($path)) {
        return;
    }
    $lines = file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
    foreach ($lines as $line) {
        $line = trim($line);
        if ($line === '' || strpos($line, '#') === 0) {
            continue;
        }
        $parts = explode('=', $line, 2);
        if (count($parts) === 2) {
            $key = trim($parts[0]);
            if (str_starts_with($key, 'export ')) {
                $key = trim(substr($key, 7));
            }
            $val = trim($parts[1]);
            // Strip surrounding quotes
            if ((str_starts_with($val, '"') && str_ends_with($val, '"')) ||
                (str_starts_with($val, "'") && str_ends_with($val, "'"))) {
                $val = substr($val, 1, -1);
            }
            if ($key === '') {
                continue;
            }
            // Preserve already-loaded non-empty values when a later .env file has an empty entry
            $existing = getenv($key);
            if ($existing === false || $existing === '') {
                $existing = $_ENV[$key] ?? ($_SERVER[$key] ?? '');
            }
            if ($val === '' && $existing !== '') {
                continue;
            }
            putenv("{$key}={$val}");
            $_ENV[$key] = $val;
            $_SERVER[$key] = $val;
        }
    }
}

// Attempt loading from common Hostinger and project .env locations
loadEnvFile(__DIR__ . '/../../.env');
loadEnvFile(__DIR__ . '/../../.env.local');
loadEnvFile(__DIR__ . '/../../.env.production');
loadEnvFile(__DIR__ . '/../.env');
loadEnvFile(__DIR__ . '/.env');
if (!empty($_SERVER['DOCUMENT_ROOT'])) {
    loadEnvFile($_SERVER['DOCUMENT_ROOT'] . '/.env');
    loadEnvFile(dirname($_SERVER['DOCUMENT_ROOT']) . '/.env');
}

function getRazorpayConfig() {
    static $cached = null;
    if ($cached !== null) {
        return $cached;
    }

    $sanitizeCredential = static function ($value) {
        if (!is_string($value) && !is_numeric($value)) {
            return '';
        }
        return trim((string)$value, " \t\n\r\0\x0B\"'");
    };

    $readEnvValue = static function ($name) use ($sanitizeCredential) {
        $val = getenv($name);
        if ($val !== false) {
            $clean = $sanitizeCredential($val);
            if ($clean !== '') {
                return $clean;
            }
        }
        if (isset($_ENV[$name])) {
            $clean = $sanitizeCredential($_ENV[$name]);
            if ($clean !== '') {
                return $clean;
            }
        }
        if (isset($_SERVER[$name])) {
            $clean = $sanitizeCredential($_SERVER[$name]);
            if ($clean !== '') {
                return $clean;
            }
        }
        if (defined($name)) {
            $constVal = constant($name);
            if (is_string($constVal) || is_numeric($constVal)) {
                $clean = $sanitizeCredential($constVal);
                if ($clean !== '') {
                    return $clean;
                }
            }
        }
        return '';
    };

    $keyId = $readEnvValue('RAZORPAY_KEY_ID');
    $keySecret = $readEnvValue('RAZORPAY_KEY_SECRET');

    // Optional Hostinger direct configuration file (mirrors db_credentials.php & smtp_credentials.php)
    $customConfigPath = __DIR__ . '/razorpay_credentials.php';
    if (file_exists($customConfigPath) && is_readable($customConfigPath)) {
        $loadCustom = static function ($__razorpayConfigPath) {
            $__returned = include $__razorpayConfigPath;
            $__defined = get_defined_vars();
            unset($__defined['__razorpayConfigPath'], $__defined['__returned']);
            return ['returned' => $__returned, 'vars' => $__defined];
        };

        $loaded = $loadCustom($customConfigPath);
        $returned = $loaded['returned'];
        $vars = $loaded['vars'];

        $extractFromArray = static function ($arr) use ($sanitizeCredential) {
            if (!is_array($arr)) {
                return ['', ''];
            }
            $id = '';
            $secret = '';
            foreach (['RAZORPAY_KEY_ID', 'razorpay_key_id', 'key_id', 'keyId'] as $k) {
                if (isset($arr[$k])) {
                    $candidate = $sanitizeCredential($arr[$k]);
                    if ($candidate !== '') {
                        $id = $candidate;
                        break;
                    }
                }
            }
            foreach (['RAZORPAY_KEY_SECRET', 'razorpay_key_secret', 'key_secret', 'keySecret', 'secret'] as $k) {
                if (isset($arr[$k])) {
                    $candidate = $sanitizeCredential($arr[$k]);
                    if ($candidate !== '') {
                        $secret = $candidate;
                        break;
                    }
                }
            }
            return [$id, $secret];
        };

        // 1. Returned associative array (e.g. `return ['RAZORPAY_KEY_ID' => '...', 'RAZORPAY_KEY_SECRET' => '...'];`)
        [$customId, $customSecret] = $extractFromArray($returned);

        // 2. Nested array variables ($config, $razorpay, etc.)
        if ($customId === '' || $customSecret === '') {
            foreach ($vars as $varVal) {
                if (is_array($varVal)) {
                    [$nId, $nSecret] = $extractFromArray($varVal);
                    if ($customId === '' && $nId !== '') {
                        $customId = $nId;
                    }
                    if ($customSecret === '' && $nSecret !== '') {
                        $customSecret = $nSecret;
                    }
                }
            }
        }

        // 3. Direct scalar variables inside razorpay_credentials.php
        if ($customId === '') {
            foreach (['RAZORPAY_KEY_ID', 'razorpay_key_id', 'key_id', 'keyId'] as $varName) {
                if (isset($vars[$varName])) {
                    $candidate = $sanitizeCredential($vars[$varName]);
                    if ($candidate !== '') {
                        $customId = $candidate;
                        break;
                    }
                }
            }
        }
        if ($customSecret === '') {
            foreach (['RAZORPAY_KEY_SECRET', 'razorpay_key_secret', 'key_secret', 'keySecret', 'secret'] as $varName) {
                if (isset($vars[$varName])) {
                    $candidate = $sanitizeCredential($vars[$varName]);
                    if ($candidate !== '') {
                        $customSecret = $candidate;
                        break;
                    }
                }
            }
        }

        // 4. Constants or env vars populated by razorpay_credentials.php
        if ($customId === '') {
            $customId = $readEnvValue('RAZORPAY_KEY_ID');
        }
        if ($customSecret === '') {
            $customSecret = $readEnvValue('RAZORPAY_KEY_SECRET');
        }

        if ($customId !== '') {
            $keyId = $customId;
        }
        if ($customSecret !== '') {
            $keySecret = $customSecret;
        }
    }

    $cached = [
        'keyId' => $keyId,
        'keySecret' => $keySecret,
        'isConfigured' => ($keyId !== '' && $keySecret !== '')
    ];

    return $cached;
}

function getDatabaseConfig() {
    $host = getenv('DB_HOST') ?: ($_ENV['DB_HOST'] ?? ($_SERVER['DB_HOST'] ?? (getenv('MYSQL_HOST') ?: ($_ENV['MYSQL_HOST'] ?? ($_SERVER['MYSQL_HOST'] ?? '')))));
    $port = getenv('DB_PORT') ?: ($_ENV['DB_PORT'] ?? ($_SERVER['DB_PORT'] ?? (getenv('MYSQL_PORT') ?: ($_ENV['MYSQL_PORT'] ?? ($_SERVER['MYSQL_PORT'] ?? '3306')))));
    $dbName = getenv('DB_NAME') ?: ($_ENV['DB_NAME'] ?? ($_SERVER['DB_NAME'] ?? (getenv('MYSQL_DATABASE') ?: ($_ENV['MYSQL_DATABASE'] ?? ($_SERVER['MYSQL_DATABASE'] ?? '')))));
    $user = getenv('DB_USER') ?: ($_ENV['DB_USER'] ?? ($_SERVER['DB_USER'] ?? (getenv('MYSQL_USER') ?: ($_ENV['MYSQL_USER'] ?? ($_SERVER['MYSQL_USER'] ?? '')))));
    $pass = getenv('DB_PASSWORD') ?: ($_ENV['DB_PASSWORD'] ?? ($_SERVER['DB_PASSWORD'] ?? (getenv('MYSQL_PASSWORD') ?: ($_ENV['MYSQL_PASSWORD'] ?? ($_SERVER['MYSQL_PASSWORD'] ?? '')))));

    // Optional Hostinger direct configuration file for users who prefer PHP array over .env
    $customConfigPath = __DIR__ . '/db_credentials.php';
    if (file_exists($customConfigPath) && is_readable($customConfigPath)) {
        $custom = include $customConfigPath;
        if (is_array($custom)) {
            $host = $custom['DB_HOST'] ?? ($custom['MYSQL_HOST'] ?? $host);
            $port = $custom['DB_PORT'] ?? ($custom['MYSQL_PORT'] ?? $port);
            $dbName = $custom['DB_NAME'] ?? ($custom['MYSQL_DATABASE'] ?? $dbName);
            $user = $custom['DB_USER'] ?? ($custom['MYSQL_USER'] ?? $user);
            $pass = $custom['DB_PASSWORD'] ?? ($custom['MYSQL_PASSWORD'] ?? $pass);
        }
    }

    return [
        'host' => trim((string)$host),
        'port' => trim((string)$port),
        'dbName' => trim((string)$dbName),
        'user' => trim((string)$user),
        'pass' => (string)$pass,
        'isConfigured' => !empty($host) && !empty($dbName) && !empty($user)
    ];
}

function getDatabaseConnection() {
    static $pdo = null;
    if ($pdo !== null) {
        return $pdo;
    }

    $conf = getDatabaseConfig();

    if (!$conf['isConfigured']) {
        error_log('[database.php] Database configuration missing: DB_HOST, DB_NAME, or DB_USER is not defined.');
        if (function_exists('jsonResponse')) {
            jsonResponse([
                'success' => false,
                'error' => 'Database connection unavailable.'
            ], 503);
        } else {
            http_response_code(503);
            header('Content-Type: application/json; charset=utf-8');
            echo json_encode([
                'success' => false,
                'error' => 'Database connection unavailable.'
            ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
            exit;
        }
    }

    $host = $conf['host'];
    $port = $conf['port'];
    $dbName = $conf['dbName'];
    $user = $conf['user'];
    $pass = $conf['pass'];

    $dsn = "mysql:host={$host};port={$port};dbname={$dbName};charset=utf8mb4";
    $options = [
        PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES   => false,
        PDO::MYSQL_ATTR_INIT_COMMAND => "SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci"
    ];

    try {
        $pdo = new PDO($dsn, $user, $pass, $options);
        return $pdo;
    } catch (Throwable $e) {
        $sqlState = $e instanceof PDOException ? (string)$e->getCode() : '';
        $driverCode = ($e instanceof PDOException && isset($e->errorInfo[1])) ? (int)$e->errorInfo[1] : 0;
        error_log("[database.php] Database connection failed (SQLSTATE={$sqlState}, errno={$driverCode}): " . $e->getMessage());

        $isUnavailable = function_exists('isDatabaseConnectionUnavailableError')
            ? isDatabaseConnectionUnavailableError($e)
            : (str_starts_with($sqlState, '08') || in_array($driverCode, [1040, 2002, 2003, 2005, 2006, 2013], true));
        $statusCode = $isUnavailable ? 503 : 500;
        $clientError = $isUnavailable
            ? 'Database connection unavailable.'
            : 'Database connection failed.';

        if (function_exists('jsonResponse')) {
            jsonResponse([
                'success' => false,
                'error' => $clientError
            ], $statusCode);
        } else {
            http_response_code($statusCode);
            header('Content-Type: application/json; charset=utf-8');
            echo json_encode([
                'success' => false,
                'error' => $clientError
            ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
            exit;
        }
    }
}
