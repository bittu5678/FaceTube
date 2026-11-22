<?php
/**
 * FaceTube - Admin Global Pool Pending Reserves & Idempotent Settlement API
 * GET  /api/admin/global-pool-settle.php — Inspect pending/settled Global Pool reserves & batches
 * POST /api/admin/global-pool-settle.php — Safely settle pending reserves under FOR UPDATE + idempotencyKey
 *
 * Strictly restricted to verified Administrators.
 * Enforces Phase 1.1 accounting rules:
 * - Zero-eligible-video ₹3.00 pools and integer-paise rounding residuals are never credited to Admin.
 * - Pending reserves are settled only through this explicit, locked, idempotent, auditable batch mechanism.
 * - Any settlement rounding residual is carried forward into a new pending reserve row (never Admin).
 */

require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/../response.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST' && $_SERVER['REQUEST_METHOD'] !== 'GET') {
    jsonResponse(['success' => false, 'error' => 'Method Not Allowed'], 405);
}

$isMissingOptionalTable = static function (Throwable $e): bool {
    if (!($e instanceof PDOException)) {
        return false;
    }
    $sqlState = (string)$e->getCode();
    $driverCode = isset($e->errorInfo[1]) ? (int)$e->errorInfo[1] : 0;
    return $sqlState === '42S02' || $driverCode === 1146;
};

$isConnectionUnavailable = static function (Throwable $e): bool {
    if (function_exists('isDatabaseConnectionUnavailableError')) {
        return isDatabaseConnectionUnavailableError($e);
    }
    $sqlState = $e instanceof PDOException ? (string)$e->getCode() : '';
    $driverCode = ($e instanceof PDOException && isset($e->errorInfo[1])) ? (int)$e->errorInfo[1] : 0;
    $msg = $e->getMessage();
    return str_starts_with($sqlState, '08')
        || in_array($driverCode, [1040, 1042, 1053, 1129, 1203, 1927, 2002, 2003, 2005, 2006, 2013, 2026], true)
        || preg_match('/server has gone away|lost connection|connection refused|connection timed out|too many connections|max_user_connections|too many user connections|server shutdown in progress|host .* is blocked|broken pipe|could not translate host|unknown mysql server host|getaddrinfo/i', $msg) === 1;
};

$safeRollback = static function (PDO $conn): void {
    try {
        if ($conn->inTransaction()) {
            $conn->rollBack();
        }
    } catch (Throwable $_rollbackErr) {
        error_log('[global-pool-settle.php][ROLLBACK] Rollback failed: ' . $_rollbackErr->getMessage());
    }
};

$makeUuid = static function (): string {
    return sprintf(
        '%04x%04x-%04x-%04x-%04x-%04x%04x%04x',
        mt_rand(0, 0xffff), mt_rand(0, 0xffff), mt_rand(0, 0xffff),
        mt_rand(0, 0x0fff) | 0x4000, mt_rand(0, 0x3fff) | 0x8000,
        mt_rand(0, 0xffff), mt_rand(0, 0xffff), mt_rand(0, 0xffff)
    );
};

$pdo = getDatabaseConnection();
try {
    $authUser = getAuthUser($pdo, true);
} catch (Throwable $e) {
    error_log('[global-pool-settle.php][AUTH] Database error: ' . $e->getMessage());
    if ($isConnectionUnavailable($e)) {
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

if (!$authUser) {
    jsonResponse([
        'success' => false,
        'error' => 'Authentication required. Please provide a valid Bearer session token.'
    ], 401);
}

if (strtolower((string)($authUser['role'] ?? '')) !== 'admin') {
    jsonResponse([
        'success' => false,
        'error' => 'Admin authorization required. Only verified administrators can manage or settle Global Pool reserves.'
    ], 403);
}

// -----------------------------------------------------------------------------
// GET: Load pending & settled Global Pool reserves and settlement batches
// -----------------------------------------------------------------------------
if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $reserves = [];
    $settlements = [];
    try {
        $stmtRes = $pdo->query('
            SELECT id, payment_id, order_id, tx_number, source_user_id, source_video_id,
                   reserve_amount, reserve_paise, reserve_reason, status, settled_batch_id,
                   settled_at, settled_by, notes, created_at, updated_at
            FROM global_pool_reserves
            ORDER BY tx_number ASC, created_at ASC
        ');
        if ($stmtRes !== false) {
            $reserves = $stmtRes->fetchAll(PDO::FETCH_ASSOC);
        }
    } catch (Throwable $e) {
        if (!$isMissingOptionalTable($e)) {
            if ($isConnectionUnavailable($e)) {
                jsonResponse(['success' => false, 'error' => 'Database connection unavailable while loading Global Pool reserves.'], 503);
            }
            jsonResponse(['success' => false, 'error' => 'Database error loading Global Pool reserves.'], 500);
        }
    }

    try {
        $stmtSet = $pdo->query('
            SELECT id, idempotency_key, total_reserve_amount, distributed_amount, carry_forward_amount,
                   reserve_count, eligible_video_count, payout_count, settled_by, notes, created_at
            FROM global_pool_settlements
            ORDER BY created_at DESC
        ');
        if ($stmtSet !== false) {
            $settlements = $stmtSet->fetchAll(PDO::FETCH_ASSOC);
        }
    } catch (Throwable $e) {
        if (!$isMissingOptionalTable($e)) {
            if ($isConnectionUnavailable($e)) {
                jsonResponse(['success' => false, 'error' => 'Database connection unavailable while loading Global Pool settlements.'], 503);
            }
            jsonResponse(['success' => false, 'error' => 'Database error loading Global Pool settlements.'], 500);
        }
    }

    $pendingCount = 0;
    $totalPendingAmount = 0.0;
    foreach ($reserves as $r) {
        if (($r['status'] ?? '') === 'pending') {
            $pendingCount++;
            $totalPendingAmount += floatval($r['reserve_amount'] ?? 0);
        }
    }

    jsonResponse([
        'success' => true,
        'pendingCount' => $pendingCount,
        'totalPendingAmount' => round($totalPendingAmount, 2),
        'reserves' => $reserves,
        'settlements' => $settlements,
    ]);
}

// -----------------------------------------------------------------------------
// POST: Safely settle pending Global Pool reserves under lock & idempotency key
// -----------------------------------------------------------------------------
$input = getRequestPayload();
$headerKey = '';
if (function_exists('getallheaders')) {
    foreach (getallheaders() as $hName => $hVal) {
        if (strcasecmp((string)$hName, 'x-idempotency-key') === 0) {
            $headerKey = trim((string)$hVal);
            break;
        }
    }
}
$idempotencyKey = trim((string)($input['idempotencyKey'] ?? ($input['idempotency_key'] ?? $headerKey)));
if ($idempotencyKey === '') {
    jsonResponse([
        'success' => false,
        'error' => 'idempotencyKey is required to safely settle Global Pool reserves without duplicate crediting.'
    ], 400);
}
$notes = isset($input['notes']) && trim((string)$input['notes']) !== '' ? trim((string)$input['notes']) : null;
$adminUserId = strtoupper(trim((string)($authUser['user_id'] ?? 'FT102857')));

// Detect optional columns on uploaded_videos before starting transaction
$hasAdEarningsCol = false;
$hasIsBlockedCol = false;
try {
    $colStmt = $pdo->query("
        SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'uploaded_videos'
          AND COLUMN_NAME IN ('ad_earnings', 'is_blocked')
    ");
    if ($colStmt) {
        foreach ($colStmt->fetchAll(PDO::FETCH_ASSOC) as $colRow) {
            $cName = strtolower((string)($colRow['COLUMN_NAME'] ?? ''));
            if ($cName === 'ad_earnings') {
                $hasAdEarningsCol = true;
            } elseif ($cName === 'is_blocked') {
                $hasIsBlockedCol = true;
            }
        }
    }
} catch (Throwable $eCol) {
    // Keep safe defaults
}

try {
    $pdo->beginTransaction();

    // 1. Idempotency check under row lock
    $stmtDup = $pdo->prepare('
        SELECT id, idempotency_key, total_reserve_amount, distributed_amount, carry_forward_amount,
               reserve_count, eligible_video_count, payout_count, settled_by, notes, created_at
        FROM global_pool_settlements WHERE idempotency_key = ? FOR UPDATE
    ');
    $stmtDup->execute([$idempotencyKey]);
    $existingBatch = $stmtDup->fetch(PDO::FETCH_ASSOC);
    if ($existingBatch) {
        $safeRollback($pdo);
        jsonResponse([
            'success' => true,
            'duplicate' => true,
            'settledCount' => intval($existingBatch['reserve_count'] ?? 0),
            'settlement' => [
                'id' => $existingBatch['id'],
                'idempotencyKey' => $existingBatch['idempotency_key'],
                'totalReserveAmount' => floatval($existingBatch['total_reserve_amount']),
                'distributedAmount' => floatval($existingBatch['distributed_amount']),
                'carryForwardAmount' => floatval($existingBatch['carry_forward_amount']),
                'reserveCount' => intval($existingBatch['reserve_count']),
                'eligibleVideoCount' => intval($existingBatch['eligible_video_count']),
                'payoutCount' => intval($existingBatch['payout_count']),
                'settledBy' => $existingBatch['settled_by'],
                'notes' => $existingBatch['notes'],
                'createdAt' => $existingBatch['created_at'],
            ],
            'message' => 'Settlement batch already processed (idempotent replay).'
        ]);
    }

    // 2. Lock pending reserves
    $stmtPending = $pdo->query("
        SELECT id, payment_id, order_id, tx_number, source_user_id, source_video_id,
               reserve_amount, reserve_paise, reserve_reason
        FROM global_pool_reserves
        WHERE status = 'pending'
        ORDER BY tx_number ASC, created_at ASC
        FOR UPDATE
    ");
    $pendingReserves = $stmtPending ? $stmtPending->fetchAll(PDO::FETCH_ASSOC) : [];
    if (empty($pendingReserves)) {
        $safeRollback($pdo);
        jsonResponse([
            'success' => true,
            'duplicate' => false,
            'settledCount' => 0,
            'remainingPendingCount' => 0,
            'totalSettledAmount' => 0,
            'settlement' => null,
            'message' => 'No pending Global Pool reserves available to settle.'
        ]);
    }

    // 3. Query eligible Sponsor/Premium videos
    $adEarningsExpr = $hasAdEarningsCol ? 'COALESCE(ad_earnings, 0.00) AS ad_earnings' : '0.00 AS ad_earnings';
    $blockedFilter = $hasIsBlockedCol ? "\n          AND (is_blocked = 0 OR is_blocked IS NULL)" : '';
    $stmtVideos = $pdo->query("
        SELECT id AS video_id, user_id, {$adEarningsExpr}
        FROM uploaded_videos
        WHERE (video_type = 'premium' OR payment_status = 'paid'){$blockedFilter}
        ORDER BY created_at ASC, id ASC
    ");
    $candidateVideos = $stmtVideos ? $stmtVideos->fetchAll(PDO::FETCH_ASSOC) : [];

    $batchId = 'gps_' . round(microtime(true) * 1000) . '_' . substr(bin2hex(random_bytes(4)), 0, 8);
    $payoutsByKey = [];
    $settledReserveRows = [];
    $rewardedVideoKeys = [];
    $totalReservePaiseProcessed = 0;
    $totalDistributedPaise = 0;
    $totalCarryForwardPaise = 0;

    $stmtMarkSettled = $pdo->prepare("
        UPDATE global_pool_reserves
        SET status = 'settled', settled_batch_id = ?, settled_at = NOW(), settled_by = ?,
            notes = COALESCE(?, notes), updated_at = NOW()
        WHERE id = ? AND status = 'pending'
    ");
    $stmtMarkReserveLedger = $pdo->prepare("
        UPDATE income_ledger
        SET status = 'settled',
            description = CONCAT(description, ' [Settled in batch ', ?, ']')
        WHERE transaction_id = ? AND user_id = 'GLOBAL_POOL_RESERVE' AND status = 'pending'
    ");

    foreach ($pendingReserves as $r) {
        $sourceNorm = strtoupper(trim((string)($r['source_user_id'] ?? '')));
        $eligibleForReserve = [];
        foreach ($candidateVideos as $cv) {
            $vUser = strtoupper(trim((string)($cv['user_id'] ?? '')));
            if ($vUser === '') {
                continue;
            }
            if ($sourceNorm !== '' && $sourceNorm !== 'GLOBAL_POOL_SETTLEMENT' && $vUser === $sourceNorm) {
                continue;
            }
            $eligibleForReserve[] = $cv;
        }

        if (empty($eligibleForReserve)) {
            continue;
        }

        $reservePaise = intval($r['reserve_paise'] ?? 0);
        if ($reservePaise <= 0) {
            $reservePaise = (int)round(floatval($r['reserve_amount'] ?? 0) * 100);
        }
        if ($reservePaise <= 0) {
            continue;
        }

        $scaledUnits = [];
        $totalUnits = 0;
        foreach ($eligibleForReserve as $idx => $ev) {
            $units = (int)round(max(0.0, floatval($ev['ad_earnings'] ?? 0)) * 10000);
            $scaledUnits[$idx] = $units;
            $totalUnits += $units;
        }

        $distributedForReserve = 0;
        if ($totalUnits > 0) {
            foreach ($eligibleForReserve as $idx => $ev) {
                $amountPaise = intdiv($scaledUnits[$idx] * $reservePaise, $totalUnits);
                $distributedForReserve += $amountPaise;
                $vUser = strtoupper(trim((string)$ev['user_id']));
                $vId = trim((string)($ev['video_id'] ?? ''));
                $key = "{$vUser}:{$vId}";
                $rewardedVideoKeys[$key] = true;
                if (!isset($payoutsByKey[$key])) {
                    $payoutsByKey[$key] = ['userId' => $vUser, 'videoId' => $vId, 'amountPaise' => 0];
                }
                $payoutsByKey[$key]['amountPaise'] += $amountPaise;
            }
        } else {
            $perVideoPaise = intdiv($reservePaise, count($eligibleForReserve));
            $distributedForReserve = $perVideoPaise * count($eligibleForReserve);
            foreach ($eligibleForReserve as $ev) {
                $vUser = strtoupper(trim((string)$ev['user_id']));
                $vId = trim((string)($ev['video_id'] ?? ''));
                $key = "{$vUser}:{$vId}";
                $rewardedVideoKeys[$key] = true;
                if (!isset($payoutsByKey[$key])) {
                    $payoutsByKey[$key] = ['userId' => $vUser, 'videoId' => $vId, 'amountPaise' => 0];
                }
                $payoutsByKey[$key]['amountPaise'] += $perVideoPaise;
            }
        }

        $carryForReserve = max(0, $reservePaise - $distributedForReserve);
        $totalReservePaiseProcessed += $reservePaise;
        $totalDistributedPaise += $distributedForReserve;
        $totalCarryForwardPaise += $carryForReserve;
        $settledReserveRows[] = $r;

        $stmtMarkSettled->execute([$batchId, $adminUserId, $notes, $r['id']]);
        $stmtMarkReserveLedger->execute([$batchId, 'TX_GLB_RESERVE_' . $r['payment_id']]);
    }

    if (empty($settledReserveRows)) {
        $safeRollback($pdo);
        jsonResponse([
            'success' => true,
            'duplicate' => false,
            'settledCount' => 0,
            'remainingPendingCount' => count($pendingReserves),
            'totalSettledAmount' => 0,
            'settlement' => null,
            'message' => 'Pending reserves remain in reserve because no eligible third-party creator videos exist yet.'
        ]);
    }

    $carryForwardReserveId = null;
    if ($totalCarryForwardPaise > 0) {
        $carryForwardReserveId = 'gpr_carry_' . $batchId;
        $carryAmt = $totalCarryForwardPaise / 100;
        $carryPayId = 'SETTLE_CARRY_' . $batchId;
        $carryDesc = "Carry-forward Global Pool rounding residual (₹{$carryAmt}) from settlement batch {$batchId}";

        $stmtCarryRes = $pdo->prepare("
            INSERT INTO global_pool_reserves (
                id, payment_id, order_id, tx_number, source_user_id, source_video_id,
                reserve_amount, reserve_paise, reserve_reason, status, notes, created_at, updated_at
            ) VALUES (?, ?, NULL, 0, 'GLOBAL_POOL_SETTLEMENT', NULL, ?, ?, 'rounding_residual', 'pending', ?, NOW(), NOW())
        ");
        $stmtCarryRes->execute([$carryForwardReserveId, $carryPayId, $carryAmt, $totalCarryForwardPaise, $carryDesc]);

        $stmtCarryLedger = $pdo->prepare("
            INSERT INTO income_ledger (
                id, transaction_id, user_id, source_user_id, source_user_name, video_id,
                income_type, amount, status, special_tag, description, created_at
            ) VALUES (?, ?, 'GLOBAL_POOL_RESERVE', 'GLOBAL_POOL_SETTLEMENT', 'Global Pool Settlement', NULL,
                'global_income', ?, 'pending', 'GLOBAL_POOL_PENDING_RESERVE', ?, NOW())
        ");
        $stmtCarryLedger->execute([$makeUuid(), 'TX_GLB_RESERVE_' . $carryPayId, $carryAmt, $carryDesc]);
    }

    $payouts = [];
    foreach ($payoutsByKey as $p) {
        if ($p['amountPaise'] > 0) {
            $payouts[] = [
                'userId' => $p['userId'],
                'videoId' => $p['videoId'],
                'amountPaise' => $p['amountPaise'],
                'amount' => $p['amountPaise'] / 100,
            ];
        }
    }

    $totalReserveAmount = $totalReservePaiseProcessed / 100;
    $distributedAmount = $totalDistributedPaise / 100;
    $carryForwardAmount = $totalCarryForwardPaise / 100;

    $stmtBatch = $pdo->prepare('
        INSERT INTO global_pool_settlements (
            id, idempotency_key, total_reserve_amount, distributed_amount, carry_forward_amount,
            reserve_count, eligible_video_count, payout_count, settled_by, notes, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
    ');
    $stmtBatch->execute([
        $batchId,
        $idempotencyKey,
        $totalReserveAmount,
        $distributedAmount,
        $carryForwardAmount,
        count($settledReserveRows),
        count($rewardedVideoKeys),
        count($payouts),
        $adminUserId,
        $notes
    ]);

    $stmtSettleLedger = $pdo->prepare("
        INSERT INTO income_ledger (
            id, transaction_id, user_id, source_user_id, source_user_name, video_id,
            income_type, amount, status, special_tag, description, created_at
        ) VALUES (?, ?, ?, 'GLOBAL_POOL_SETTLEMENT', 'Global Pool Reserve Settlement', ?,
            'global_income', ?, 'settled', 'GLOBAL_POOL_SETTLEMENT', ?, NOW())
    ");
    $stmtSettleWallet = $pdo->prepare('
        INSERT INTO wallet_balances (user_id, balance, total_earned, total_withdrawn, referral_income, global_income, adsense_income, affiliate_income, updated_at)
        VALUES (?, ?, ?, 0.00, 0.00, ?, 0.00, 0.00, NOW())
        ON DUPLICATE KEY UPDATE
            balance = balance + VALUES(balance),
            total_earned = total_earned + VALUES(total_earned),
            global_income = global_income + VALUES(global_income),
            updated_at = NOW()
    ');

    foreach ($payouts as $payout) {
        $vSuffix = !empty($payout['videoId']) ? $payout['videoId'] : $payout['userId'];
        $txSettleId = "TX_GLB_SETTLE_{$batchId}_{$vSuffix}";
        $desc = !empty($payout['videoId'])
            ? "Global Pool reserve settlement batch {$batchId} for video #{$payout['videoId']} (₹{$payout['amount']})"
            : "Global Pool reserve settlement batch {$batchId} (₹{$payout['amount']})";

        $stmtSettleLedger->execute([
            $makeUuid(),
            $txSettleId,
            $payout['userId'],
            !empty($payout['videoId']) ? $payout['videoId'] : null,
            $payout['amount'],
            $desc
        ]);

        $stmtSettleWallet->execute([
            $payout['userId'],
            $payout['amount'],
            $payout['amount'],
            $payout['amount']
        ]);
    }

    $pdo->commit();

    jsonResponse([
        'success' => true,
        'duplicate' => false,
        'settledCount' => count($settledReserveRows),
        'remainingPendingCount' => count($pendingReserves) - count($settledReserveRows),
        'totalSettledAmount' => $distributedAmount,
        'settlement' => [
            'id' => $batchId,
            'idempotencyKey' => $idempotencyKey,
            'totalReserveAmount' => $totalReserveAmount,
            'distributedAmount' => $distributedAmount,
            'carryForwardAmount' => $carryForwardAmount,
            'reserveCount' => count($settledReserveRows),
            'eligibleVideoCount' => count($rewardedVideoKeys),
            'payoutCount' => count($payouts),
            'settledBy' => $adminUserId,
            'notes' => $notes,
            'payouts' => $payouts,
            'carryForwardReserveId' => $carryForwardReserveId,
        ],
    ]);
} catch (Throwable $e) {
    $safeRollback($pdo);

    if (
        !$isConnectionUnavailable($e) &&
        ((string)$e->getCode() === '23000' || str_contains($e->getMessage(), 'uniq_gps_idempotency') || str_contains($e->getMessage(), 'Duplicate entry'))
    ) {
        jsonResponse([
            'success' => true,
            'duplicate' => true,
            'message' => 'Settlement batch already processed (idempotent replay).'
        ]);
    }

    if ($isMissingOptionalTable($e)) {
        jsonResponse([
            'success' => false,
            'error' => 'Global Pool reserve schema migration has not been applied yet.'
        ], 503);
    }

    if ($isConnectionUnavailable($e)) {
        jsonResponse([
            'success' => false,
            'error' => 'Database connection unavailable while settling Global Pool reserves. Transaction safely rolled back.'
        ], 503);
    }

    error_log('[global-pool-settle.php] Settlement error: ' . $e->getMessage());
    jsonResponse([
        'success' => false,
        'error' => 'Failed to settle Global Pool reserves. Transaction safely rolled back.'
    ], 500);
}
