<?php
/**
 * FaceTube - Creator Watch Time Analytics API
 * GET /api/watch-time/analytics.php
 *
 * - Authenticated creator-isolated access (cross-user restricted to admins)
 * - Aggregates real video_watch_daily rows in UTC
 * - Average View Duration = qualified_watched_seconds / qualified_sessions (0 when 0)
 * - Returns null growth_percent when no prior baseline exists (no fake data)
 */

require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/../response.php';
require_once __DIR__ . '/_shared.php';

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'GET') {
    jsonResponse(['success' => false, 'error' => 'Method Not Allowed'], 405);
}

$pdo = getDatabaseConnection();
$authUser = wtRequireAuthenticatedUser($pdo);

$rawRequestedUserId = trim((string)($_GET['user_id'] ?? ($_GET['userId'] ?? '')));
$authPublicId = trim((string)$authUser['user_id']);
$authInternalId = trim((string)($authUser['id'] ?? ''));

if ($rawRequestedUserId === '') {
    $creatorUserId = $authPublicId;
} elseif (
    strcasecmp($rawRequestedUserId, $authPublicId) === 0
    || ($authInternalId !== '' && strcasecmp($rawRequestedUserId, $authInternalId) === 0)
) {
    $creatorUserId = $authPublicId;
} else {
    $isAdmin = isset($authUser['role']) && strtolower(trim((string)$authUser['role'])) === 'admin';
    if (!$isAdmin) {
        jsonResponse([
            'success' => false,
            'error' => 'Unauthorized: Cross-user access is restricted to verified administrators.'
        ], 403);
    }
    $creatorUserId = $rawRequestedUserId;
}

try {
    $uStmt = $pdo->prepare('SELECT user_id FROM users WHERE UPPER(user_id) = UPPER(?) OR UPPER(id) = UPPER(?) LIMIT 1');
    $uStmt->execute([$creatorUserId, $creatorUserId]);
    $uRow = $uStmt->fetch(PDO::FETCH_ASSOC);
    if ($uRow && !empty($uRow['user_id'])) {
        $creatorUserId = trim((string)$uRow['user_id']);
    }
} catch (Throwable $e) {
    if (wtIsConnectionUnavailableError($e)) {
        jsonResponse(['success' => false, 'error' => 'Database connection unavailable.'], 503);
    }
}

$rawPeriod = strtoupper(trim((string)($_GET['period'] ?? '')));
$rawDays = intval($_GET['days'] ?? 0);

$period = '7D';
$days = 7;

if ($rawPeriod === '7D' || $rawDays === 7) {
    $period = '7D';
    $days = 7;
} elseif ($rawPeriod === '28D' || $rawDays === 28) {
    $period = '28D';
    $days = 28;
} elseif ($rawPeriod === '30D' || $rawDays === 30) {
    $period = '30D';
    $days = 30;
} elseif ($rawPeriod === '90D' || $rawDays === 90) {
    $period = '90D';
    $days = 90;
} elseif ($rawPeriod === '12M' || $rawDays >= 365) {
    $period = '12M';
    $days = 365;
} elseif ($rawDays > 0) {
    $days = max(7, min(365, $rawDays));
    $period = $days <= 7 ? '7D' : ($days === 28 ? '28D' : ($days <= 30 ? '30D' : ($days <= 90 ? '90D' : '12M')));
}

$nowEpoch = time();
$todayUtcDate = wtFormatUtcDate($nowEpoch);
$currentStartEpoch = $nowEpoch - (($days - 1) * 86400);
$currentStartDate = wtFormatUtcDate($currentStartEpoch);
$prevEndDate = wtFormatUtcDate($currentStartEpoch - 86400);
$prevStartDate = wtFormatUtcDate($currentStartEpoch - ($days * 86400));

$timelineMap = [];
$utcTz = new DateTimeZone('UTC');

if ($period === '12M') {
    $baseMonth = new DateTimeImmutable(gmdate('Y-m-01 00:00:00', $nowEpoch), $utcTz);
    for ($i = 11; $i >= 0; $i--) {
        $dtObj = $baseMonth->modify("-{$i} months");
        $key = $dtObj->format('Y-m');
        $label = $dtObj->format('M y');
        $timelineMap[$key] = [
            'date' => $key,
            'day' => $label,
            'watched_seconds' => 0,
            'hours' => 0.0,
            'qualified_watched_seconds' => 0,
            'qualified_sessions' => 0,
        ];
    }
} else {
    for ($i = $days - 1; $i >= 0; $i--) {
        $dEpoch = $nowEpoch - ($i * 86400);
        $key = wtFormatUtcDate($dEpoch);
        $dtObj = new DateTimeImmutable('@' . $dEpoch);
        $dtObj = $dtObj->setTimezone($utcTz);
        $label = $days <= 7 ? $dtObj->format('D') : $dtObj->format('M j');
        $timelineMap[$key] = [
            'date' => $key,
            'day' => $label,
            'watched_seconds' => 0,
            'hours' => 0.0,
            'qualified_watched_seconds' => 0,
            'qualified_sessions' => 0,
        ];
    }
}

try {
    $lifeStmt = $pdo->prepare('
        SELECT
            COALESCE(SUM(total_watched_seconds), 0) AS total_sec,
            COALESCE(SUM(qualified_watched_seconds), 0) AS qual_sec,
            COALESCE(SUM(qualified_sessions), 0) AS qual_sessions
        FROM video_watch_daily
        WHERE UPPER(creator_user_id) = UPPER(?)
    ');
    $lifeStmt->execute([$creatorUserId]);
    $lifeRow = $lifeStmt->fetch(PDO::FETCH_ASSOC) ?: [];
    $lifetimeTotalSec = (int)($lifeRow['total_sec'] ?? 0);
    $lifetimeQualifiedSec = (int)($lifeRow['qual_sec'] ?? 0);
    $lifetimeQualifiedSessions = (int)($lifeRow['qual_sessions'] ?? 0);

    $currTotalSec = 0;
    $currQualifiedSec = 0;
    $currQualifiedSessions = 0;
    $prevTotalSec = 0;
    $topVideos = [];

    if ($period === '12M') {
        $baseMonth = new DateTimeImmutable(gmdate('Y-m-01 00:00:00', $nowEpoch), $utcTz);
        $startMonthDate = $baseMonth->modify('-11 months')->format('Y-m-d');
        $prev12MStartDate = $baseMonth->modify('-23 months')->format('Y-m-d');
        $prev12MEndDate = $baseMonth->modify('-11 months -1 day')->format('Y-m-d');

        $bucketStmt = $pdo->prepare("
            SELECT
                DATE_FORMAT(watch_date, '%Y-%m') AS period_key,
                COALESCE(SUM(total_watched_seconds), 0) AS total_sec,
                COALESCE(SUM(qualified_watched_seconds), 0) AS qual_sec,
                COALESCE(SUM(qualified_sessions), 0) AS qual_sessions
            FROM video_watch_daily
            WHERE UPPER(creator_user_id) = UPPER(?)
              AND watch_date >= ?
              AND watch_date <= ?
            GROUP BY DATE_FORMAT(watch_date, '%Y-%m')
            ORDER BY period_key ASC
        ");
        $bucketStmt->execute([$creatorUserId, $startMonthDate, $todayUtcDate]);
        $bucketRows = $bucketStmt->fetchAll(PDO::FETCH_ASSOC);

        foreach ($bucketRows as $r) {
            $k = (string)($r['period_key'] ?? '');
            $sec = (int)($r['total_sec'] ?? 0);
            $qSec = (int)($r['qual_sec'] ?? 0);
            $qSess = (int)($r['qual_sessions'] ?? 0);
            $currTotalSec += $sec;
            $currQualifiedSec += $qSec;
            $currQualifiedSessions += $qSess;
            if (isset($timelineMap[$k])) {
                $timelineMap[$k]['watched_seconds'] = $sec;
                $timelineMap[$k]['hours'] = round($sec / 3600, 2);
                $timelineMap[$k]['qualified_watched_seconds'] = $qSec;
                $timelineMap[$k]['qualified_sessions'] = $qSess;
            }
        }

        $prevStmt = $pdo->prepare('
            SELECT COALESCE(SUM(total_watched_seconds), 0) AS total_sec
            FROM video_watch_daily
            WHERE UPPER(creator_user_id) = UPPER(?)
              AND watch_date >= ?
              AND watch_date <= ?
        ');
        $prevStmt->execute([$creatorUserId, $prev12MStartDate, $prev12MEndDate]);
        $prevRow = $prevStmt->fetch(PDO::FETCH_ASSOC) ?: [];
        $prevTotalSec = (int)($prevRow['total_sec'] ?? 0);

        $topStmt = $pdo->prepare("
            SELECT
                d.video_id,
                COALESCE(v.title, d.video_id) AS title,
                COALESCE(v.content_type, 'long') AS content_type,
                COALESCE(SUM(d.total_watched_seconds), 0) AS total_sec,
                COALESCE(SUM(d.qualified_watched_seconds), 0) AS qual_sec,
                COALESCE(SUM(d.qualified_sessions), 0) AS qual_sessions
            FROM video_watch_daily d
            LEFT JOIN uploaded_videos v ON v.id = d.video_id
            WHERE UPPER(d.creator_user_id) = UPPER(?)
              AND d.watch_date >= ?
              AND d.watch_date <= ?
            GROUP BY d.video_id, v.title, v.content_type
            ORDER BY total_sec DESC
            LIMIT 10
        ");
        $topStmt->execute([$creatorUserId, $startMonthDate, $todayUtcDate]);
        $topRows = $topStmt->fetchAll(PDO::FETCH_ASSOC);
    } else {
        $bucketStmt = $pdo->prepare("
            SELECT
                DATE_FORMAT(watch_date, '%Y-%m-%d') AS period_key,
                COALESCE(SUM(total_watched_seconds), 0) AS total_sec,
                COALESCE(SUM(qualified_watched_seconds), 0) AS qual_sec,
                COALESCE(SUM(qualified_sessions), 0) AS qual_sessions
            FROM video_watch_daily
            WHERE UPPER(creator_user_id) = UPPER(?)
              AND watch_date >= ?
              AND watch_date <= ?
            GROUP BY DATE_FORMAT(watch_date, '%Y-%m-%d')
            ORDER BY period_key ASC
        ");
        $bucketStmt->execute([$creatorUserId, $currentStartDate, $todayUtcDate]);
        $bucketRows = $bucketStmt->fetchAll(PDO::FETCH_ASSOC);

        foreach ($bucketRows as $r) {
            $k = (string)($r['period_key'] ?? '');
            $sec = (int)($r['total_sec'] ?? 0);
            $qSec = (int)($r['qual_sec'] ?? 0);
            $qSess = (int)($r['qual_sessions'] ?? 0);
            $currTotalSec += $sec;
            $currQualifiedSec += $qSec;
            $currQualifiedSessions += $qSess;
            if (isset($timelineMap[$k])) {
                $timelineMap[$k]['watched_seconds'] = $sec;
                $timelineMap[$k]['hours'] = round($sec / 3600, 2);
                $timelineMap[$k]['qualified_watched_seconds'] = $qSec;
                $timelineMap[$k]['qualified_sessions'] = $qSess;
            }
        }

        $prevStmt = $pdo->prepare('
            SELECT COALESCE(SUM(total_watched_seconds), 0) AS total_sec
            FROM video_watch_daily
            WHERE UPPER(creator_user_id) = UPPER(?)
              AND watch_date >= ?
              AND watch_date <= ?
        ');
        $prevStmt->execute([$creatorUserId, $prevStartDate, $prevEndDate]);
        $prevRow = $prevStmt->fetch(PDO::FETCH_ASSOC) ?: [];
        $prevTotalSec = (int)($prevRow['total_sec'] ?? 0);

        $topStmt = $pdo->prepare("
            SELECT
                d.video_id,
                COALESCE(v.title, d.video_id) AS title,
                COALESCE(v.content_type, 'long') AS content_type,
                COALESCE(SUM(d.total_watched_seconds), 0) AS total_sec,
                COALESCE(SUM(d.qualified_watched_seconds), 0) AS qual_sec,
                COALESCE(SUM(d.qualified_sessions), 0) AS qual_sessions
            FROM video_watch_daily d
            LEFT JOIN uploaded_videos v ON v.id = d.video_id
            WHERE UPPER(d.creator_user_id) = UPPER(?)
              AND d.watch_date >= ?
              AND d.watch_date <= ?
            GROUP BY d.video_id, v.title, v.content_type
            ORDER BY total_sec DESC
            LIMIT 10
        ");
        $topStmt->execute([$creatorUserId, $currentStartDate, $todayUtcDate]);
        $topRows = $topStmt->fetchAll(PDO::FETCH_ASSOC);
    }

    foreach ($topRows as $r) {
        $sec = (int)($r['total_sec'] ?? 0);
        $qSec = (int)($r['qual_sec'] ?? 0);
        $qSess = (int)($r['qual_sessions'] ?? 0);
        $avgSec = wtComputeAverageViewDurationSeconds($qSec, $qSess);
        $topVideos[] = [
            'video_id' => (string)$r['video_id'],
            'title' => (string)($r['title'] ?? $r['video_id']),
            'content_type' => strtolower((string)($r['content_type'] ?? 'long')) === 'short' ? 'short' : 'long',
            'total_watched_seconds' => $sec,
            'hours' => round($sec / 3600, 2),
            'qualified_watched_seconds' => $qSec,
            'qualified_sessions' => $qSess,
            'avg_view_duration_seconds' => $avgSec,
            'avg_view_duration_formatted' => wtFormatDurationCompact($avgSec),
        ];
    }

    $periodAvgSec = wtComputeAverageViewDurationSeconds($currQualifiedSec, $currQualifiedSessions);
    $lifetimeAvgSec = wtComputeAverageViewDurationSeconds($lifetimeQualifiedSec, $lifetimeQualifiedSessions);
    $growthPercent = $prevTotalSec > 0
        ? round((($currTotalSec - $prevTotalSec) / $prevTotalSec) * 100, 1)
        : null;

    jsonResponse([
        'success' => true,
        'creator_user_id' => $creatorUserId,
        'period' => $period,
        'days' => $days,
        'timezone' => 'UTC',
        'has_data' => $lifetimeTotalSec > 0,
        'summary' => [
            'total_watched_seconds' => $currTotalSec,
            'total_hours' => round($currTotalSec / 3600, 2),
            'qualified_watched_seconds' => $currQualifiedSec,
            'qualified_sessions' => $currQualifiedSessions,
            'avg_view_duration_seconds' => $periodAvgSec,
            'avg_view_duration_formatted' => wtFormatDurationCompact($periodAvgSec),
            'previous_period_watched_seconds' => $prevTotalSec,
            'growth_percent' => $growthPercent,
        ],
        'lifetime' => [
            'total_watched_seconds' => $lifetimeTotalSec,
            'total_hours' => round($lifetimeTotalSec / 3600, 2),
            'qualified_watched_seconds' => $lifetimeQualifiedSec,
            'qualified_sessions' => $lifetimeQualifiedSessions,
            'avg_view_duration_seconds' => $lifetimeAvgSec,
            'avg_view_duration_formatted' => wtFormatDurationCompact($lifetimeAvgSec),
        ],
        'history' => array_values($timelineMap),
        'top_videos' => $topVideos,
    ]);
} catch (Throwable $e) {
    error_log('[watch-time/analytics.php] Error: ' . $e->getMessage());
    if (wtIsConnectionUnavailableError($e)) {
        jsonResponse(['success' => false, 'error' => 'Database connection unavailable while querying analytics.'], 503);
    }
    jsonResponse(['success' => false, 'error' => 'Database error while querying watch-time analytics.'], 500);
}
