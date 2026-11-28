<?php
/**
 * FaceTube - Record Watch Time Heartbeat API
 * POST /api/watch-time/heartbeat.php
 *
 * - Authenticated viewers only
 * - Locks watch_sessions row via SELECT ... FOR UPDATE inside DB transaction
 * - Enforces atomic idempotency, monotonic seq, expiry, superseded grace flush,
 *   bounded client/server wall-clock delta, session/daily/velocity caps,
 *   UTC midnight splitting, and exactly-once qualified session counting.
 */

require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/../response.php';
require_once __DIR__ . '/_shared.php';

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    jsonResponse(['success' => false, 'error' => 'Method Not Allowed'], 405);
}

$pdo = getDatabaseConnection();
$authUser = wtRequireAuthenticatedUser($pdo);

$rawBody = file_get_contents('php://input');
$payload = [];
if ($rawBody !== false && trim($rawBody) !== '') {
    $decoded = json_decode($rawBody, true);
    if (
        json_last_error() !== JSON_ERROR_NONE
        || !is_array($decoded)
        || (!empty($decoded) && array_keys($decoded) === range(0, count($decoded) - 1))
    ) {
        jsonResponse(['success' => false, 'error' => 'Invalid JSON request body.'], 400);
    }
    $payload = $decoded;
} elseif (!empty($_POST)) {
    $payload = $_POST;
}

$sessionId = trim((string)($payload['session_id'] ?? ($payload['sessionId'] ?? '')));
$idempotencyKey = trim((string)($payload['idempotency_key'] ?? ($payload['idempotencyKey'] ?? '')));
$rawSeq = $payload['seq'] ?? null;
$rawDelta = $payload['delta_seconds'] ?? ($payload['deltaSeconds'] ?? null);
$rawPos = $payload['position_seconds'] ?? ($payload['positionSeconds'] ?? 0);
$rawEventType = strtolower(trim((string)($payload['event_type'] ?? ($payload['eventType'] ?? 'heartbeat'))));
$rawClientTs = $payload['client_timestamp'] ?? ($payload['clientTimestamp'] ?? ($payload['client_event_at'] ?? null));

if ($sessionId === '') {
    jsonResponse(['success' => false, 'error' => 'session_id is required.'], 400);
}
if ($idempotencyKey === '' || strlen($idempotencyKey) > 100 || preg_match('/^[A-Za-z0-9_.:-]+$/', $idempotencyKey) !== 1) {
    jsonResponse(['success' => false, 'error' => 'Valid idempotency_key (1-100 safe chars) is required.'], 400);
}

$seq = wtParseStrictInt($rawSeq);
if ($seq === null || $seq < 1) {
    jsonResponse(['success' => false, 'error' => 'seq must be a positive integer >= 1.'], 400);
}

$deltaSeconds = wtParseStrictInt($rawDelta);
if ($deltaSeconds === null || $deltaSeconds < 1 || $deltaSeconds > WT_MAX_DELTA_SEC) {
    jsonResponse(['success' => false, 'error' => 'delta_seconds must be an integer between 1 and ' . WT_MAX_DELTA_SEC . '.'], 400);
}

if (!in_array($rawEventType, WT_VALID_EVENT_TYPES, true)) {
    jsonResponse(['success' => false, 'error' => 'Invalid event_type.'], 400);
}
$eventType = $rawEventType;

$posNum = is_numeric($rawPos) ? (float)$rawPos : 0.0;
$positionSeconds = ($posNum >= 0 && is_finite($posNum)) ? min(86400, (int)floor($posNum)) : 0;

$parsedClientEpoch = null;
if ($rawClientTs !== null && trim((string)$rawClientTs) !== '') {
    $parsedClientEpoch = wtParseUtcDatetimeToEpoch($rawClientTs);
    if ($parsedClientEpoch === null) {
        jsonResponse(['success' => false, 'error' => 'Invalid client_timestamp format.'], 400);
    }
}

$viewerUserId = trim((string)$authUser['user_id']);
$nowEpoch = time();
$nowSql = wtToMysqlUtcDatetime($nowEpoch);

if ($parsedClientEpoch !== null && $parsedClientEpoch > $nowEpoch + WT_MAX_FUTURE_CLIENT_SKEW_SEC) {
    jsonResponse([
        'success' => false,
        'code' => 'INVALID_CLIENT_TIMESTAMP',
        'error' => 'client_timestamp cannot be significantly in the future.'
    ], 400);
}

$maxAttempts = 3;
for ($attempt = 1; $attempt <= $maxAttempts; $attempt++) {
try {
    $nowEpoch = time();
    $nowSql = wtToMysqlUtcDatetime($nowEpoch);

    $pdo->beginTransaction();

    // 0. Acquire authenticated viewer's users row lock first (strict hierarchy: users -> watch_sessions -> events/daily)
    $uLockStmt = $pdo->prepare('SELECT id FROM users WHERE user_id = ? FOR UPDATE');
    $uLockStmt->execute([$viewerUserId]);
    if (!$uLockStmt->fetch(PDO::FETCH_ASSOC)) {
        wtSafeRollback($pdo);
        jsonResponse(['success' => false, 'error' => 'Authentication required. Viewer account not found.'], 401);
    }

    // 1. Lock watch_sessions row via SELECT ... FOR UPDATE
    $sStmt = $pdo->prepare('SELECT * FROM watch_sessions WHERE id = ? FOR UPDATE');
    $sStmt->execute([$sessionId]);
    $session = $sStmt->fetch(PDO::FETCH_ASSOC);

    if (!$session) {
        wtSafeRollback($pdo);
        jsonResponse(['success' => false, 'error' => 'Watch session not found.'], 404);
    }

    if (strcasecmp(trim((string)$session['viewer_user_id']), $viewerUserId) !== 0) {
        wtSafeRollback($pdo);
        jsonResponse(['success' => false, 'error' => 'Unauthorized: Watch session belongs to another user.'], 403);
    }

    // 2. Atomic idempotency check under viewer + session locks
    $dupStmt = $pdo->prepare('
        SELECT id, session_id, seq, event_type, watched_seconds
        FROM watch_time_events
        WHERE idempotency_key = ?
        LIMIT 1
    ');
    $dupStmt->execute([$idempotencyKey]);
    $dupRow = $dupStmt->fetch(PDO::FETCH_ASSOC);
    if ($dupRow) {
        if ((string)($dupRow['session_id'] ?? '') !== $sessionId) {
            wtSafeRollback($pdo);
            jsonResponse([
                'success' => false,
                'code' => 'IDEMPOTENCY_CONFLICT',
                'error' => 'Idempotency key was already used for a different watch session.'
            ], 409);
        }
        if (
            (int)($dupRow['seq'] ?? 0) !== $seq
            || (int)($dupRow['watched_seconds'] ?? 0) !== $deltaSeconds
            || strtolower(trim((string)($dupRow['event_type'] ?? ''))) !== $eventType
        ) {
            wtSafeRollback($pdo);
            jsonResponse([
                'success' => false,
                'code' => 'IDEMPOTENCY_CONFLICT',
                'error' => 'Idempotency key conflict: parameters do not match original event.'
            ], 409);
        }
        $pdo->commit();
        jsonResponse([
            'success' => true,
            'deduplicated' => true,
            'session_id' => $sessionId,
            'credited_seconds' => 0,
            'total_watched_seconds' => (int)($session['total_watched_seconds'] ?? 0),
            'is_qualified' => (bool)($session['is_qualified'] ?? false),
            'status' => $session['status'],
        ]);
    }

    // 3. Reject duplicate seq with different idempotency_key or out-of-order seq
    $seqStmt = $pdo->prepare('SELECT id FROM watch_time_events WHERE session_id = ? AND seq = ? LIMIT 1');
    $seqStmt->execute([$sessionId, $seq]);
    if ($seqStmt->fetch(PDO::FETCH_ASSOC)) {
        wtSafeRollback($pdo);
        jsonResponse([
            'success' => false,
            'code' => 'SEQUENCE_CONFLICT',
            'error' => 'Sequence number already processed with a different idempotency_key.'
        ], 409);
    }

    $lastSeq = (int)($session['last_seq'] ?? 0);
    if ($seq <= $lastSeq) {
        wtSafeRollback($pdo);
        jsonResponse([
            'success' => false,
            'code' => 'SEQUENCE_CONFLICT',
            'error' => 'Sequence number must be greater than last committed sequence.'
        ], 409);
    }

    $startedEpoch = wtParseUtcDatetimeToEpoch($session['started_at'] ?? null) ?? $nowEpoch;
    $lastHbEpoch = wtParseUtcDatetimeToEpoch($session['last_heartbeat_at'] ?? null) ?? $startedEpoch;
    $expiresEpoch = wtParseUtcDatetimeToEpoch($session['expires_at'] ?? null) ?? ($startedEpoch + WT_SESSION_TTL_SECONDS);
    $endedEpoch = wtParseUtcDatetimeToEpoch($session['ended_at'] ?? null);

    // 4. Hard session expiry check
    if ($nowEpoch > $expiresEpoch) {
        if ($session['status'] === 'active') {
            $expUp = $pdo->prepare("UPDATE watch_sessions SET status = 'ended', close_reason = 'expired', ended_at = COALESCE(ended_at, ?) WHERE id = ?");
            $expUp->execute([$nowSql, $sessionId]);
            $pdo->commit();
        } else {
            wtSafeRollback($pdo);
        }
        jsonResponse([
            'success' => false,
            'code' => 'SESSION_EXPIRED',
            'error' => 'Watch session has expired.'
        ], 409);
    }

    // 5. Status & bounded one-time superseded grace flush check
    $markSupersededGraceUsed = !empty($session['superseded_grace_used']);
    $isSupersededGrace = false;
    if ($session['status'] === 'ended') {
        $canUseSupersededGrace = ($session['close_reason'] ?? '') === 'superseded'
            && !$markSupersededGraceUsed
            && $seq === ($lastSeq + 1)
            && $endedEpoch !== null
            && $nowEpoch <= ($endedEpoch + WT_SUPERSEDED_FLUSH_WINDOW_SEC)
            && ($parsedClientEpoch === null || $parsedClientEpoch <= ($endedEpoch + WT_WALL_CLOCK_JITTER_TOLERANCE_SEC));

        if (!$canUseSupersededGrace) {
            wtSafeRollback($pdo);
            jsonResponse([
                'success' => false,
                'code' => 'SESSION_ENDED',
                'error' => 'Watch session has already ended.'
            ], 409);
        }
        $isSupersededGrace = true;
        $markSupersededGraceUsed = true;
    }

    // 6. Bound untrusted client timestamp and validate wall-clock elapsed limits
    if ($parsedClientEpoch !== null && $parsedClientEpoch < ($startedEpoch - WT_WALL_CLOCK_JITTER_TOLERANCE_SEC)) {
        wtSafeRollback($pdo);
        jsonResponse([
            'success' => false,
            'code' => 'INVALID_CLIENT_TIMESTAMP',
            'error' => 'client_timestamp precedes session start.'
        ], 400);
    }

    if ($isSupersededGrace) {
        // Never credit playback time after server-authoritative ended_at; no stacked jitter tolerances
        $segmentEndEpoch = ($parsedClientEpoch !== null)
            ? min($endedEpoch, $nowEpoch, max($startedEpoch, $parsedClientEpoch))
            : min($endedEpoch, $nowEpoch);

        if (($endedEpoch - $lastHbEpoch) < $deltaSeconds) {
            wtSafeRollback($pdo);
            jsonResponse([
                'success' => false,
                'code' => 'DELTA_EXCEEDS_ELAPSED_TIME',
                'error' => 'delta_seconds exceeds elapsed time before session ended.'
            ], 400);
        }

        if ($parsedClientEpoch !== null && ($segmentEndEpoch - $lastHbEpoch + WT_WALL_CLOCK_JITTER_TOLERANCE_SEC) < $deltaSeconds) {
            wtSafeRollback($pdo);
            jsonResponse([
                'success' => false,
                'code' => 'DELTA_EXCEEDS_ELAPSED_TIME',
                'error' => 'delta_seconds exceeds elapsed time since last heartbeat.'
            ], 400);
        }
    } else {
        $segmentEndEpoch = $nowEpoch;
        if ($parsedClientEpoch !== null) {
            $segmentEndEpoch = min($nowEpoch, max($startedEpoch, $parsedClientEpoch));
            if ($segmentEndEpoch - $lastHbEpoch + WT_WALL_CLOCK_JITTER_TOLERANCE_SEC < $deltaSeconds) {
                wtSafeRollback($pdo);
                jsonResponse([
                    'success' => false,
                    'code' => 'DELTA_EXCEEDS_ELAPSED_TIME',
                    'error' => 'delta_seconds exceeds elapsed time since last heartbeat.'
                ], 400);
            }
        }

        if ($nowEpoch - $lastHbEpoch + WT_WALL_CLOCK_JITTER_TOLERANCE_SEC < $deltaSeconds) {
            wtSafeRollback($pdo);
            jsonResponse([
                'success' => false,
                'code' => 'DELTA_EXCEEDS_ELAPSED_TIME',
                'error' => 'delta_seconds exceeds server wall-clock elapsed time.'
            ], 400);
        }
    }

    // 7. Session cap check
    $contentType = strtolower(trim((string)($session['content_type'] ?? 'long'))) === 'short' ? 'short' : 'long';
    $durationSec = (int)($session['video_duration_seconds'] ?? 0);
    $sessionCap = wtComputeSessionCapSeconds($contentType, $durationSec);
    $prevTotal = (int)($session['total_watched_seconds'] ?? 0);

    if ($prevTotal + $deltaSeconds > $sessionCap) {
        wtSafeRollback($pdo);
        jsonResponse([
            'success' => false,
            'code' => 'SESSION_CAP_REACHED',
            'error' => 'Maximum watch-time cap reached for this session.'
        ], 429);
    }

    // 8. Global viewer velocity limits (60s and 3600s windows) under viewer lock
    $vel60Stmt = $pdo->prepare('
        SELECT COALESCE(SUM(watched_seconds), 0) AS total_sec
        FROM watch_time_events
        WHERE viewer_user_id = ?
          AND created_at >= ?
    ');
    $vel60Stmt->execute([$viewerUserId, wtToMysqlUtcDatetime($nowEpoch - 60)]);
    $vel60Row = $vel60Stmt->fetch(PDO::FETCH_ASSOC);
    if (((int)($vel60Row['total_sec'] ?? 0) + $deltaSeconds) > WT_GLOBAL_60S_VELOCITY_CAP_SEC) {
        wtSafeRollback($pdo);
        jsonResponse([
            'success' => false,
            'code' => 'VIEWER_VELOCITY_LIMIT',
            'error' => 'Watch-time velocity limit exceeded (60s window).'
        ], 429);
    }

    $vel3600Stmt = $pdo->prepare('
        SELECT COALESCE(SUM(watched_seconds), 0) AS total_sec
        FROM watch_time_events
        WHERE viewer_user_id = ?
          AND created_at >= ?
    ');
    $vel3600Stmt->execute([$viewerUserId, wtToMysqlUtcDatetime($nowEpoch - 3600)]);
    $vel3600Row = $vel3600Stmt->fetch(PDO::FETCH_ASSOC);
    if (((int)($vel3600Row['total_sec'] ?? 0) + $deltaSeconds) > WT_GLOBAL_3600S_VELOCITY_CAP_SEC) {
        wtSafeRollback($pdo);
        jsonResponse([
            'success' => false,
            'code' => 'VIEWER_HOURLY_LIMIT',
            'error' => 'Hourly viewer watch-time limit exceeded.'
        ], 429);
    }

    // 9. UTC midnight boundary split & per-(viewer, video, UTC date) daily caps under viewer lock
    $split = wtSplitWatchSecondsAcrossUtcMidnight($segmentEndEpoch, $deltaSeconds);
    $dailyCap = wtGetDailyVideoCapSeconds($contentType);

    $dayCheckStmt = $pdo->prepare('
        SELECT COALESCE(
            SUM(CASE WHEN watch_date = ? THEN primary_date_seconds ELSE 0 END) +
            SUM(CASE WHEN split_prev_date = ? THEN split_prev_seconds ELSE 0 END),
            0
        ) AS day_sec
        FROM watch_time_events
        WHERE viewer_user_id = ?
          AND video_id = ?
          AND (watch_date = ? OR split_prev_date = ?)
    ');
    foreach ($split['slices'] as $slice) {
        $d = $slice['watchDate'];
        $dayCheckStmt->execute([$d, $d, $viewerUserId, $session['video_id'], $d, $d]);
        $dayRow = $dayCheckStmt->fetch(PDO::FETCH_ASSOC);
        if (((int)($dayRow['day_sec'] ?? 0) + $slice['seconds']) > $dailyCap) {
            wtSafeRollback($pdo);
            jsonResponse([
                'success' => false,
                'code' => 'DAILY_VIDEO_CAP_REACHED',
                'error' => 'Daily per-video watch-time cap reached for this viewer.'
            ], 429);
        }
    }

    // 10. Qualification transition (exactly once per non-self session >= 3s)
    $isSelfWatch = !empty($session['is_self_watch']);
    $wasQualified = !empty($session['is_qualified']);
    $newTotal = $prevTotal + $deltaSeconds;
    $newlyQualified = !$isSelfWatch && !$wasQualified && $newTotal >= WT_MIN_QUALIFIED_WATCH_SECONDS;

    $qualifiedWatchDate = !empty($session['qualified_watch_date'])
        ? substr((string)$session['qualified_watch_date'], 0, 10)
        : null;
    if ($newlyQualified) {
        if (
            $split['splitPrevDate'] !== null
            && $split['splitPrevSeconds'] > 0
            && ($prevTotal + $split['splitPrevSeconds']) >= WT_MIN_QUALIFIED_WATCH_SECONDS
        ) {
            $qualifiedWatchDate = $split['splitPrevDate'];
        } else {
            $qualifiedWatchDate = $split['watchDate'];
        }
    }

    $clientEventSql = $parsedClientEpoch !== null ? wtToMysqlUtcDatetime($segmentEndEpoch) : null;

    try {
        $insEvStmt = $pdo->prepare('
            INSERT INTO watch_time_events (
                session_id, viewer_user_id, video_id, seq, idempotency_key,
                event_type, watched_seconds, position_seconds, client_event_at,
                watch_date, primary_date_seconds, split_prev_date, split_prev_seconds,
                created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ');
        $insEvStmt->execute([
            $sessionId,
            $viewerUserId,
            $session['video_id'],
            $seq,
            $idempotencyKey,
            $eventType,
            $deltaSeconds,
            $positionSeconds,
            $clientEventSql,
            $split['watchDate'],
            $split['primaryDateSeconds'],
            $split['splitPrevDate'],
            $split['splitPrevSeconds'],
            $nowSql,
        ]);
    } catch (Throwable $insErr) {
        if (wtIsDuplicateKeyError($insErr)) {
            wtSafeRollback($pdo);
            jsonResponse([
                'success' => false,
                'code' => 'SEQUENCE_CONFLICT',
                'error' => 'Duplicate sequence or idempotency key conflict.'
            ], 409);
        }
        throw $insErr;
    }

    $nextStatus = ($session['status'] === 'ended' || $eventType === 'ended' || $eventType === 'unload')
        ? 'ended'
        : 'active';
    $nextCloseReason = $session['status'] === 'ended'
        ? $session['close_reason']
        : (($eventType === 'ended' || $eventType === 'unload') ? $eventType : null);
    $nextEndedAt = $session['status'] === 'ended'
        ? $session['ended_at']
        : ($nextStatus === 'ended' ? $nowSql : null);
    $nextIsQualified = ($wasQualified || $newlyQualified) ? 1 : 0;

    $upSessStmt = $pdo->prepare('
        UPDATE watch_sessions
        SET total_watched_seconds = ?,
            is_qualified = ?,
            qualified_watch_date = ?,
            last_seq = ?,
            last_position_seconds = ?,
            last_heartbeat_at = ?,
            status = ?,
            close_reason = ?,
            ended_at = ?,
            superseded_grace_used = ?
        WHERE id = ?
    ');
    $upSessStmt->execute([
        $newTotal,
        $nextIsQualified,
        $qualifiedWatchDate,
        $seq,
        $positionSeconds,
        $nowSql,
        $nextStatus,
        $nextCloseReason,
        $nextEndedAt,
        $markSupersededGraceUsed ? 1 : 0,
        $sessionId,
    ]);

    // 11. Atomic daily rollup updates (self-watches excluded from creator watch-time metrics)
    if (!$isSelfWatch) {
        $dailyUpsertStmt = $pdo->prepare('
            INSERT INTO video_watch_daily (
                watch_date, creator_user_id, video_id,
                total_watched_seconds, qualified_watched_seconds, qualified_sessions
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                total_watched_seconds = total_watched_seconds + VALUES(total_watched_seconds),
                qualified_watched_seconds = qualified_watched_seconds + VALUES(qualified_watched_seconds),
                qualified_sessions = qualified_sessions + VALUES(qualified_sessions)
        ');

        $sliceCount = count($split['slices']);
        foreach ($split['slices'] as $slice) {
            $sliceDate = $slice['watchDate'];
            $sliceSec = $slice['seconds'];
            $sliceQualifiedSec = 0;
            $sliceQualifiedCount = 0;

            if ($wasQualified) {
                $sliceQualifiedSec = $sliceSec;
            } elseif ($newlyQualified) {
                if ($sliceDate === $qualifiedWatchDate) {
                    $sliceQualifiedCount = 1;
                    if ($sliceCount === 2 && $qualifiedWatchDate === $split['watchDate']) {
                        $sliceQualifiedSec = $newTotal;
                    } else {
                        $sliceQualifiedSec = $prevTotal + $sliceSec;
                    }
                } elseif (
                    $sliceCount === 2
                    && $qualifiedWatchDate === $split['splitPrevDate']
                    && $sliceDate === $split['watchDate']
                ) {
                    $sliceQualifiedSec = $sliceSec;
                }
            }

            $dailyUpsertStmt->execute([
                $sliceDate,
                $session['creator_user_id'],
                $session['video_id'],
                $sliceSec,
                $sliceQualifiedSec,
                $sliceQualifiedCount,
            ]);
        }
    }

    $pdo->commit();

    jsonResponse([
        'success' => true,
        'deduplicated' => false,
        'session_id' => $sessionId,
        'seq' => $seq,
        'credited_seconds' => $deltaSeconds,
        'total_watched_seconds' => $newTotal,
        'is_qualified' => (bool)$nextIsQualified,
        'status' => $nextStatus,
    ]);
} catch (Throwable $e) {
    wtSafeRollback($pdo);
    if (wtIsRetryableTransactionError($e)) {
        if ($attempt < $maxAttempts) {
            usleep(20000 * $attempt);
            continue;
        }
        error_log('[watch-time/heartbeat.php] Transient transaction conflict: ' . $e->getMessage());
        jsonResponse([
            'success' => false,
            'code' => 'TRANSACTION_CONFLICT',
            'error' => 'Temporary transaction conflict while recording watch time. Please retry.'
        ], 409);
    }
    error_log('[watch-time/heartbeat.php] Error: ' . $e->getMessage());
    if (wtIsConnectionUnavailableError($e)) {
        jsonResponse(['success' => false, 'error' => 'Database connection unavailable while recording watch time.'], 503);
    }
    jsonResponse(['success' => false, 'error' => 'Database error while recording watch time.'], 500);
}
}
