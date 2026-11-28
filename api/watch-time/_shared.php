<?php
/**
 * FaceTube - Shared Watch Time Tracking Helpers (Phase 2)
 * Matches src/server/watch-time.ts constants, validation, locking, rate-limits,
 * UTC midnight splitting, and qualified AVD formulas 1:1.
 */

const WT_HEARTBEAT_INTERVAL_SEC = 15;
const WT_MAX_DELTA_SEC = 30;
const WT_MIN_QUALIFIED_WATCH_SECONDS = 3;
const WT_SESSION_TTL_SECONDS = 86400; // 24 hours
const WT_WALL_CLOCK_JITTER_TOLERANCE_SEC = 5;
const WT_MAX_FUTURE_CLIENT_SKEW_SEC = 300;
const WT_SHORT_SESSION_CAP_MAX_SEC = 180;
const WT_SHORT_SESSION_CAP_MIN_SEC = 60;
const WT_SHORT_DAILY_CAP_SEC = 300;
const WT_LONG_SESSION_CAP_MAX_SEC = 14400;
const WT_LONG_SESSION_CAP_MIN_SEC = 300;
const WT_LONG_SESSION_CAP_UNKNOWN_DURATION_SEC = 3600;
const WT_LONG_DAILY_CAP_SEC = 14400;
const WT_GLOBAL_60S_VELOCITY_CAP_SEC = 75;
const WT_GLOBAL_3600S_VELOCITY_CAP_SEC = 4200;
const WT_MAX_CONCURRENT_ACTIVE_SESSIONS = 2;
const WT_MAX_SESSIONS_PER_MINUTE = 30;
const WT_SUPERSEDED_FLUSH_WINDOW_SEC = 120;
const WT_VALID_EVENT_TYPES = ['heartbeat', 'pause', 'hidden', 'ended', 'unload'];

function wtParseStrictInt($raw): ?int {
    if (is_bool($raw) || $raw === null || is_array($raw) || is_object($raw)) {
        return null;
    }
    if (is_int($raw)) {
        return $raw;
    }
    if (is_string($raw)) {
        $trimmed = trim($raw);
        if ($trimmed === '' || preg_match('/^-?\d+$/', $trimmed) !== 1) {
            return null;
        }
        $parsed = filter_var($trimmed, FILTER_VALIDATE_INT);
        return $parsed === false ? null : (int)$parsed;
    }
    return null;
}

function wtIsConnectionUnavailableError(Throwable $e): bool {
    if (function_exists('isDatabaseConnectionUnavailableError')) {
        return isDatabaseConnectionUnavailableError($e);
    }
    $sqlState = $e instanceof PDOException ? (string)$e->getCode() : '';
    $driverCode = ($e instanceof PDOException && isset($e->errorInfo[1])) ? (int)$e->errorInfo[1] : 0;
    $msg = $e->getMessage();
    return str_starts_with($sqlState, '08')
        || in_array($driverCode, [1040, 1042, 1053, 1129, 1203, 1927, 2002, 2003, 2005, 2006, 2013, 2026], true)
        || preg_match('/server has gone away|lost connection|connection refused|connection timed out|too many connections|max_user_connections|too many user connections|server shutdown in progress|host .* is blocked|broken pipe|could not translate host|unknown mysql server host|getaddrinfo/i', $msg) === 1;
}

function wtIsDuplicateKeyError(Throwable $e): bool {
    if (!($e instanceof PDOException)) {
        return false;
    }
    $sqlState = (string)$e->getCode();
    $driverCode = isset($e->errorInfo[1]) ? (int)$e->errorInfo[1] : 0;
    return $sqlState === '23000' || $driverCode === 1062;
}

function wtIsRetryableTransactionError(Throwable $e): bool {
    if (!($e instanceof PDOException)) {
        return false;
    }
    $sqlState = (string)$e->getCode();
    $driverCode = isset($e->errorInfo[1]) ? (int)$e->errorInfo[1] : 0;
    if (in_array($driverCode, [1213, 1205], true) || $sqlState === '40001') {
        return true;
    }
    $msg = $e->getMessage();
    return preg_match('/Deadlock found|Lock wait timeout/i', $msg) === 1;
}

function wtSafeRollback(PDO $pdo): void {
    try {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
    } catch (Throwable $_err) {
        error_log('[watch-time][ROLLBACK] Rollback failed: ' . $_err->getMessage());
    }
}

function wtHasSuppliedAuthHeader(): bool {
    $candidates = [
        $_SERVER['HTTP_AUTHORIZATION'] ?? null,
        $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? null,
        $_SERVER['REDIRECT_REDIRECT_HTTP_AUTHORIZATION'] ?? null,
        $_SERVER['Authorization'] ?? null,
        $_SERVER['HTTP_X_AUTHORIZATION'] ?? null,
        $_SERVER['REDIRECT_HTTP_X_AUTHORIZATION'] ?? null,
        $_SERVER['REDIRECT_REDIRECT_HTTP_X_AUTHORIZATION'] ?? null,
        $_SERVER['X-Authorization'] ?? null,
        $_SERVER['X_AUTHORIZATION'] ?? null,
    ];
    foreach ($candidates as $candidate) {
        if ($candidate !== null && trim((string)$candidate) !== '') {
            return true;
        }
    }
    $requestHeaders = [];
    if (function_exists('getallheaders')) {
        $requestHeaders = getallheaders() ?: [];
    } elseif (function_exists('apache_request_headers')) {
        $requestHeaders = apache_request_headers() ?: [];
    }
    if (!empty($requestHeaders) && is_array($requestHeaders)) {
        foreach ($requestHeaders as $key => $val) {
            if (
                (strcasecmp((string)$key, 'Authorization') === 0 || strcasecmp((string)$key, 'X-Authorization') === 0)
                && $val !== null
                && trim((string)$val) !== ''
            ) {
                return true;
            }
        }
    }
    foreach ([
        'HTTP_AUTHORIZATION',
        'REDIRECT_HTTP_AUTHORIZATION',
        'REDIRECT_REDIRECT_HTTP_AUTHORIZATION',
        'HTTP_X_AUTHORIZATION',
        'REDIRECT_HTTP_X_AUTHORIZATION',
        'REDIRECT_REDIRECT_HTTP_X_AUTHORIZATION',
    ] as $envKey) {
        $envVal = getenv($envKey);
        if ($envVal !== false && trim((string)$envVal) !== '') {
            return true;
        }
    }
    return false;
}

function wtRequireAuthenticatedUser(PDO $pdo): array {
    $authHeaderSupplied = wtHasSuppliedAuthHeader();
    $token = getBearerToken();

    if ($authHeaderSupplied && $token === null) {
        jsonResponse([
            'success' => false,
            'error' => 'Malformed or empty Bearer authorization header. Please provide a valid Bearer session token.'
        ], 401);
    }

    if ($token === null) {
        jsonResponse([
            'success' => false,
            'error' => 'Authentication required. Please provide a valid Bearer session token.'
        ], 401);
    }

    try {
        $authUser = getAuthUser($pdo, true);
    } catch (Throwable $e) {
        error_log('[watch-time][AUTH] Database error: ' . $e->getMessage());
        if (wtIsConnectionUnavailableError($e)) {
            jsonResponse([
                'success' => false,
                'error' => 'Database connection unavailable during authentication check.'
            ], 503);
        }
        jsonResponse([
            'success' => false,
            'error' => 'Database error during authentication check.'
        ], 500);
    }

    if (!$authUser || empty($authUser['user_id'])) {
        jsonResponse([
            'success' => false,
            'error' => 'Authentication required. Please provide a valid Bearer session token.'
        ], 401);
    }

    return $authUser;
}

function wtResolveVisibilityFailClosed($value): string {
    if ($value === null) {
        return 'public';
    }
    $clean = strtolower(trim((string)$value));
    if ($clean === '') {
        return 'public';
    }
    if (in_array($clean, ['public', 'unlisted', 'private'], true)) {
        return $clean;
    }
    return 'private';
}

function wtParseVideoDurationSeconds($raw): int {
    if (is_int($raw) || is_float($raw)) {
        if ($raw > 0 && is_finite((float)$raw)) {
            return min(86400, (int)floor((float)$raw));
        }
        return 0;
    }
    $clean = trim((string)$raw);
    if ($clean === '') {
        return 0;
    }
    if (preg_match('/^\d+$/', $clean) === 1) {
        return min(86400, max(0, (int)$clean));
    }
    $parts = explode(':', $clean);
    foreach ($parts as $p) {
        if (!is_numeric($p) || (float)$p < 0) {
            return 0;
        }
    }
    if (count($parts) === 2) {
        return min(86400, (int)floor(((float)$parts[0]) * 60 + (float)$parts[1]));
    }
    if (count($parts) === 3) {
        return min(86400, (int)floor(((float)$parts[0]) * 3600 + ((float)$parts[1]) * 60 + (float)$parts[2]));
    }
    return 0;
}

function wtComputeSessionCapSeconds(string $contentType, int $durationSeconds): int {
    if ($contentType === 'short') {
        return $durationSeconds > 0
            ? min(WT_SHORT_SESSION_CAP_MAX_SEC, max(WT_SHORT_SESSION_CAP_MIN_SEC, $durationSeconds * 3))
            : WT_SHORT_SESSION_CAP_MAX_SEC;
    }
    return $durationSeconds > 0
        ? min(WT_LONG_SESSION_CAP_MAX_SEC, max(WT_LONG_SESSION_CAP_MIN_SEC, $durationSeconds * 2))
        : WT_LONG_SESSION_CAP_UNKNOWN_DURATION_SEC;
}

function wtGetDailyVideoCapSeconds(string $contentType): int {
    return $contentType === 'short' ? WT_SHORT_DAILY_CAP_SEC : WT_LONG_DAILY_CAP_SEC;
}

function wtToMysqlUtcDatetime(int $epochSec): string {
    return gmdate('Y-m-d H:i:s', $epochSec);
}

function wtFormatUtcDate(int $epochSec): string {
    return gmdate('Y-m-d', $epochSec);
}

function wtParseUtcDatetimeToEpoch($raw): ?int {
    if ($raw === null) {
        return null;
    }
    if (is_int($raw) || is_float($raw)) {
        $num = (float)$raw;
        if (!is_finite($num) || $num <= 0) {
            return null;
        }
        return $num > 1e12 ? (int)floor($num / 1000) : (int)floor($num);
    }
    $str = trim((string)$raw);
    if ($str === '') {
        return null;
    }
    if (preg_match('/^\d{10,13}$/', $str) === 1) {
        $num = (float)$str;
        return $num > 1e12 ? (int)floor($num / 1000) : (int)floor($num);
    }
    $hasZone = str_ends_with($str, 'Z')
        || str_ends_with($str, 'z')
        || preg_match('/[+-]\d{2}:?\d{2}$/', $str) === 1;
    $tz = new DateTimeZone('UTC');
    try {
        $dt = $hasZone ? new DateTimeImmutable($str) : new DateTimeImmutable($str, $tz);
        return $dt->getTimestamp();
    } catch (Throwable $_e) {
        return null;
    }
}

function wtSplitWatchSecondsAcrossUtcMidnight(int $segmentEndEpoch, int $deltaSeconds): array {
    $segmentStartEpoch = $segmentEndEpoch - $deltaSeconds;
    $startDate = wtFormatUtcDate($segmentStartEpoch);
    $endDate = wtFormatUtcDate($segmentEndEpoch);

    if ($startDate === $endDate) {
        return [
            'watchDate' => $endDate,
            'primaryDateSeconds' => $deltaSeconds,
            'splitPrevDate' => null,
            'splitPrevSeconds' => 0,
            'slices' => [
                ['watchDate' => $endDate, 'seconds' => $deltaSeconds],
            ],
        ];
    }

    $endMidnightDt = new DateTimeImmutable($endDate . ' 00:00:00', new DateTimeZone('UTC'));
    $endMidnightEpoch = $endMidnightDt->getTimestamp();
    $day1Seconds = max(0, min($deltaSeconds, $endMidnightEpoch - $segmentStartEpoch));
    $day2Seconds = max(0, $deltaSeconds - $day1Seconds);

    $slices = [];
    if ($day1Seconds > 0) {
        $slices[] = ['watchDate' => $startDate, 'seconds' => $day1Seconds];
    }
    if ($day2Seconds > 0) {
        $slices[] = ['watchDate' => $endDate, 'seconds' => $day2Seconds];
    }

    return [
        'watchDate' => $endDate,
        'primaryDateSeconds' => $day2Seconds,
        'splitPrevDate' => $day1Seconds > 0 ? $startDate : null,
        'splitPrevSeconds' => $day1Seconds,
        'slices' => $slices,
    ];
}

function wtComputeAverageViewDurationSeconds(int $qualifiedWatchedSeconds, int $qualifiedSessions): int {
    if ($qualifiedSessions <= 0 || $qualifiedWatchedSeconds <= 0) {
        return 0;
    }
    return (int)round($qualifiedWatchedSeconds / $qualifiedSessions);
}

function wtFormatDurationCompact(int $totalSeconds): string {
    $secs = max(0, $totalSeconds);
    $hours = (int)floor($secs / 3600);
    $mins = (int)floor(($secs % 3600) / 60);
    $remSecs = $secs % 60;
    if ($hours > 0) {
        return "{$hours}h {$mins}m {$remSecs}s";
    }
    return "{$mins}m {$remSecs}s";
}
