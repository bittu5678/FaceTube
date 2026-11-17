<?php
/**
 * FaceTube - Admin Affiliate Conversions & Settlement Management API
 * GET  /api/admin/affiliate/conversions.php - Query, filter and aggregate conversion records
 * POST /api/admin/affiliate/conversions.php - Perform status transitions: approve, settle, reject, reverse
 */

require_once __DIR__ . '/../../config/database.php';
require_once __DIR__ . '/../../response.php';

$pdo = getDatabaseConnection();
$authUser = getAuthUser($pdo);

if (!$authUser) {
    jsonResponse([
        'success' => false,
        'error' => 'Authentication required. Please provide a valid Bearer session token.'
    ], 401);
}

if (strtolower($authUser['role'] ?? '') !== 'admin') {
    jsonResponse([
        'success' => false,
        'error' => 'Admin authorization required. Access restricted to verified administrators.'
    ], 403);
}

// -----------------------------------------------------------------------------
// GET: Query Affiliate Conversions & Financial Summaries
// -----------------------------------------------------------------------------
if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $network = strtolower(trim((string)($_GET['network'] ?? '')));
    $status = strtolower(trim((string)($_GET['status'] ?? '')));
    $creatorUserId = strtoupper(trim((string)($_GET['creator_user_id'] ?? ($_GET['userId'] ?? ''))));
    $page = max(1, intval($_GET['page'] ?? 1));
    $limit = max(1, min(100, intval($_GET['limit'] ?? 25)));
    $offset = ($page - 1) * $limit;

    try {
        $where = [];
        $params = [];

        if (!empty($network)) {
            $where[] = 'c.network = ?';
            $params[] = $network;
        }
        if (!empty($status)) {
            $where[] = 'c.status = ?';
            $params[] = $status;
        }
        if (!empty($creatorUserId)) {
            $where[] = 'UPPER(c.creator_user_id) = ?';
            $params[] = $creatorUserId;
        }

        $whereClause = !empty($where) ? 'WHERE ' . implode(' AND ', $where) : '';

        // 1. Total counts and financial aggregates
        $aggSql = "
            SELECT 
                COUNT(*) AS total_conversions,
                COALESCE(SUM(c.order_amount), 0) AS total_order_amount,
                COALESCE(SUM(c.total_commission), 0) AS total_commission,
                COALESCE(SUM(c.creator_payout), 0) AS total_creator_payout,
                SUM(CASE WHEN c.status = 'pending' THEN 1 ELSE 0 END) AS pending_count,
                SUM(CASE WHEN c.status = 'approved' THEN 1 ELSE 0 END) AS approved_count,
                SUM(CASE WHEN c.status = 'settled' THEN 1 ELSE 0 END) AS settled_count,
                SUM(CASE WHEN c.status = 'rejected' THEN 1 ELSE 0 END) AS rejected_count,
                SUM(CASE WHEN c.status = 'reversed' THEN 1 ELSE 0 END) AS reversed_count
            FROM affiliate_conversions c
            {$whereClause}
        ";
        $aggStmt = $pdo->prepare($aggSql);
        $aggStmt->execute($params);
        $summary = $aggStmt->fetch() ?: [];

        // 2. Fetch paginated records
        $listSql = "
            SELECT 
                c.id,
                c.network,
                c.external_action_id,
                c.click_id,
                c.creator_user_id,
                u.name AS creator_name,
                c.video_id,
                c.order_amount,
                c.total_commission,
                c.creator_share_percentage,
                c.creator_payout,
                c.currency,
                c.status,
                c.settlement_due_at,
                c.settled_at,
                c.ledger_transaction_id,
                c.notes,
                c.created_at,
                c.updated_at
            FROM affiliate_conversions c
            LEFT JOIN users u ON UPPER(u.user_id) = UPPER(c.creator_user_id)
            {$whereClause}
            ORDER BY c.created_at DESC
            LIMIT {$limit} OFFSET {$offset}
        ";
        $listStmt = $pdo->prepare($listSql);
        $listStmt->execute($params);
        $conversions = $listStmt->fetchAll() ?: [];

        $total = intval($summary['total_conversions'] ?? 0);
        $totalPages = $total > 0 ? ceil($total / $limit) : 1;

        jsonResponse([
            'success' => true,
            'conversions' => $conversions,
            'pagination' => [
                'page' => $page,
                'limit' => $limit,
                'total' => $total,
                'totalPages' => $totalPages
            ],
            'summary' => [
                'totalConversions' => $total,
                'totalOrderAmount' => floatval($summary['total_order_amount'] ?? 0),
                'totalCommission' => floatval($summary['total_commission'] ?? 0),
                'totalCreatorPayout' => floatval($summary['total_creator_payout'] ?? 0),
                'pendingCount' => intval($summary['pending_count'] ?? 0),
                'approvedCount' => intval($summary['approved_count'] ?? 0),
                'settledCount' => intval($summary['settled_count'] ?? 0),
                'rejectedCount' => intval($summary['rejected_count'] ?? 0),
                'reversedCount' => intval($summary['reversed_count'] ?? 0),
            ]
        ]);
    } catch (Exception $e) {
        jsonResponse([
            'success' => true,
            'conversions' => [],
            'pagination' => ['page' => 1, 'limit' => $limit, 'total' => 0, 'totalPages' => 1],
            'summary' => [
                'totalConversions' => 0,
                'totalOrderAmount' => 0.0,
                'totalCommission' => 0.0,
                'totalCreatorPayout' => 0.0,
                'pendingCount' => 0,
                'approvedCount' => 0,
                'settledCount' => 0,
                'rejectedCount' => 0,
                'reversedCount' => 0,
            ]
        ]);
    }
}

// -----------------------------------------------------------------------------
// POST: Process Conversion Actions (Approve, Settle, Reject, Reverse)
// -----------------------------------------------------------------------------
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $payload = getRequestPayload();
    $conversionId = trim((string)($payload['conversion_id'] ?? ($payload['id'] ?? '')));
    $action = strtolower(trim((string)($payload['action'] ?? '')));
    $notes = trim((string)($payload['notes'] ?? ''));

    if (empty($conversionId)) {
        jsonResponse(['success' => false, 'error' => 'Conversion ID (conversion_id) is required.'], 400);
    }

    if (!in_array($action, ['approve', 'settle', 'reject', 'reverse'], true)) {
        jsonResponse(['success' => false, 'error' => "Invalid action. Supported actions: 'approve', 'settle', 'reject', 'reverse'."], 400);
    }

    try {
        $pdo->beginTransaction();

        // Lock row for safe concurrent modification
        $lockStmt = $pdo->prepare('
            SELECT * FROM affiliate_conversions WHERE id = ? FOR UPDATE
        ');
        $lockStmt->execute([$conversionId]);
        $conv = $lockStmt->fetch();

        if (!$conv) {
            $pdo->rollBack();
            jsonResponse(['success' => false, 'error' => "Conversion '{$conversionId}' not found."], 404);
        }

        $currentStatus = $conv['status'];
        $network = $conv['network'];
        $externalActionId = $conv['external_action_id'];
        $creatorUserId = $conv['creator_user_id'];
        $creatorPayout = floatval($conv['creator_payout']);
        $cleanActionId = preg_replace('/[^0-9A-Za-z]/', '', $externalActionId);
        $cleanNetwork = strtoupper(preg_replace('/[^0-9A-Za-z]/', '', $network));

        // -------------------------------------------------------------------------
        // ACTION: APPROVE (pending -> approved)
        // -------------------------------------------------------------------------
        if ($action === 'approve') {
            if ($currentStatus !== 'pending') {
                $pdo->rollBack();
                jsonResponse(['success' => false, 'error' => "Cannot approve conversion with current status '{$currentStatus}'."], 400);
            }

            $upStmt = $pdo->prepare('
                UPDATE affiliate_conversions 
                SET status = "approved", notes = CONCAT(COALESCE(notes, ""), "\n[Approved]: ", ?), updated_at = NOW()
                WHERE id = ?
            ');
            $upStmt->execute([$notes ?: 'Approved by admin', $conversionId]);

            // Audit
            $auditStmt = $pdo->prepare('
                INSERT INTO affiliate_audit_log (id, conversion_id, action, previous_status, new_status, amount_adjusted, performed_by, notes, created_at)
                VALUES (?, ?, "approved", "pending", "approved", 0.00, ?, ?, NOW())
            ');
            $auditStmt->execute(['aud_' . bin2hex(random_bytes(16)), $conversionId, $authUser['user_id'], $notes]);

            $pdo->commit();
            jsonResponse(['success' => true, 'message' => "Conversion approved successfully.", 'status' => 'approved']);
        }

        // -------------------------------------------------------------------------
        // ACTION: SETTLE (approved or pending -> settled with atomic ledger + wallet credit)
        // -------------------------------------------------------------------------
        if ($action === 'settle') {
            if ($currentStatus === 'settled') {
                $pdo->rollBack();
                jsonResponse(['success' => false, 'error' => "Conversion is already settled."], 409);
            }
            if ($currentStatus === 'reversed' || $currentStatus === 'rejected') {
                $pdo->rollBack();
                jsonResponse(['success' => false, 'error' => "Cannot settle a conversion with status '{$currentStatus}'."], 400);
            }

            if ($creatorPayout <= 0) {
                $pdo->rollBack();
                jsonResponse(['success' => false, 'error' => "Creator payout amount is ₹0.00. Cannot settle zero payout."], 400);
            }

            $txId = "TX_AFF_{$cleanNetwork}_{$cleanActionId}";

            // Check if ledger transaction ID already exists
            $checkLedger = $pdo->prepare('SELECT id FROM income_ledger WHERE transaction_id = ? LIMIT 1');
            $checkLedger->execute([$txId]);
            if ($checkLedger->fetch()) {
                $pdo->rollBack();
                jsonResponse(['success' => false, 'error' => "Ledger transaction {$txId} already settled."], 409);
            }

            $ledgerUuid = 'led_' . bin2hex(random_bytes(16));
            $desc = "Verified Affiliate Commission: {$network} (Action: {$externalActionId})";

            // 1. Insert into income_ledger
            $insLedger = $pdo->prepare('
                INSERT INTO income_ledger (
                    id, transaction_id, user_id, source_user_id, source_user_name, video_id,
                    income_type, amount, status, special_tag, description, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, "affiliate_income", ?, "settled", "AFFILIATE_SETTLEMENT", ?, NOW())
            ');
            $insLedger->execute([
                $ledgerUuid,
                $txId,
                $creatorUserId,
                $authUser['user_id'],
                $authUser['name'] ?? 'FaceTube Administrator',
                $conv['video_id'],
                $creatorPayout,
                $desc
            ]);

            // 2. Atomic credit to wallet_balances
            $upWallet = $pdo->prepare('
                INSERT INTO wallet_balances (user_id, balance, total_earned, total_withdrawn, referral_income, global_income, adsense_income, affiliate_income, updated_at)
                VALUES (?, ?, ?, 0.00, 0.00, 0.00, 0.00, ?, NOW())
                ON DUPLICATE KEY UPDATE
                    balance = balance + VALUES(balance),
                    total_earned = total_earned + VALUES(total_earned),
                    affiliate_income = affiliate_income + VALUES(affiliate_income),
                    updated_at = NOW()
            ');
            $upWallet->execute([$creatorUserId, $creatorPayout, $creatorPayout, $creatorPayout]);

            // 3. Update conversion record
            $upConv = $pdo->prepare('
                UPDATE affiliate_conversions
                SET status = "settled", settled_at = NOW(), ledger_transaction_id = ?, notes = CONCAT(COALESCE(notes, ""), "\n[Settled]: ", ?), updated_at = NOW()
                WHERE id = ?
            ');
            $upConv->execute([$txId, $notes ?: 'Settled by admin', $conversionId]);

            // 4. Audit log
            $auditStmt = $pdo->prepare('
                INSERT INTO affiliate_audit_log (id, conversion_id, action, previous_status, new_status, amount_adjusted, ledger_transaction_id, performed_by, notes, created_at)
                VALUES (?, ?, "settled", ?, "settled", ?, ?, ?, ?, NOW())
            ');
            $auditStmt->execute(['aud_' . bin2hex(random_bytes(16)), $conversionId, $currentStatus, $creatorPayout, $txId, $authUser['user_id'], $notes]);

            $pdo->commit();

            jsonResponse([
                'success' => true,
                'message' => "Successfully settled ₹{$creatorPayout} affiliate income for creator {$creatorUserId}.",
                'transaction_id' => $txId,
                'creator_payout' => $creatorPayout,
                'status' => 'settled'
            ]);
        }

        // -------------------------------------------------------------------------
        // ACTION: REJECT (pending or approved -> rejected)
        // -------------------------------------------------------------------------
        if ($action === 'reject') {
            if ($currentStatus === 'settled') {
                $pdo->rollBack();
                jsonResponse(['success' => false, 'error' => "Cannot reject an already settled conversion. Use 'reverse' instead."], 400);
            }

            $upConv = $pdo->prepare('
                UPDATE affiliate_conversions
                SET status = "rejected", notes = CONCAT(COALESCE(notes, ""), "\n[Rejected]: ", ?), updated_at = NOW()
                WHERE id = ?
            ');
            $upConv->execute([$notes ?: 'Rejected by admin', $conversionId]);

            // Audit
            $auditStmt = $pdo->prepare('
                INSERT INTO affiliate_audit_log (id, conversion_id, action, previous_status, new_status, amount_adjusted, performed_by, notes, created_at)
                VALUES (?, ?, "rejected", ?, "rejected", 0.00, ?, ?, NOW())
            ');
            $auditStmt->execute(['aud_' . bin2hex(random_bytes(16)), $conversionId, $currentStatus, $authUser['user_id'], $notes]);

            $pdo->commit();
            jsonResponse(['success' => true, 'message' => "Conversion marked as rejected.", 'status' => 'rejected']);
        }

        // -------------------------------------------------------------------------
        // ACTION: REVERSE (settled -> reversed with atomic ledger offset + wallet deduction)
        // -------------------------------------------------------------------------
        if ($action === 'reverse') {
            if ($currentStatus === 'reversed') {
                $pdo->rollBack();
                jsonResponse(['success' => false, 'error' => "Conversion is already reversed."], 409);
            }

            if ($currentStatus === 'settled') {
                // Must perform atomic financial reversal
                $revTxId = "TX_AFF_REV_{$cleanNetwork}_{$cleanActionId}";
                $revUuid = 'led_' . bin2hex(random_bytes(16));
                $revDesc = "Reversal of Settled Affiliate Commission: {$network} (Action: {$externalActionId})";

                // Insert negative ledger entry
                $insLedger = $pdo->prepare('
                    INSERT INTO income_ledger (
                        id, transaction_id, user_id, source_user_id, source_user_name, video_id,
                        income_type, amount, status, special_tag, description, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, "affiliate_income", ?, "settled", "AFFILIATE_REVERSAL", ?, NOW())
                ');
                $insLedger->execute([
                    $revUuid,
                    $revTxId,
                    $creatorUserId,
                    $authUser['user_id'],
                    $authUser['name'] ?? 'FaceTube Administrator',
                    $conv['video_id'],
                    -$creatorPayout,
                    $revDesc
                ]);

                // Atomically deduct from wallet_balances
                $upWallet = $pdo->prepare('
                    UPDATE wallet_balances
                    SET balance = GREATEST(0, balance - ?),
                        total_earned = GREATEST(0, total_earned - ?),
                        affiliate_income = GREATEST(0, affiliate_income - ?),
                        updated_at = NOW()
                    WHERE UPPER(user_id) = UPPER(?)
                ');
                $upWallet->execute([$creatorPayout, $creatorPayout, $creatorPayout, $creatorUserId]);

                // Update conversion
                $upConv = $pdo->prepare('
                    UPDATE affiliate_conversions
                    SET status = "reversed", notes = CONCAT(COALESCE(notes, ""), "\n[Reversed]: ", ?), updated_at = NOW()
                    WHERE id = ?
                ');
                $upConv->execute([$notes ?: 'Reversed settled conversion', $conversionId]);

                // Audit log
                $auditStmt = $pdo->prepare('
                    INSERT INTO affiliate_audit_log (id, conversion_id, action, previous_status, new_status, amount_adjusted, ledger_transaction_id, performed_by, notes, created_at)
                    VALUES (?, ?, "reversed", "settled", "reversed", ?, ?, ?, ?, NOW())
                ');
                $auditStmt->execute(['aud_' . bin2hex(random_bytes(16)), $conversionId, -$creatorPayout, $revTxId, $authUser['user_id'], $notes]);

                $pdo->commit();

                jsonResponse([
                    'success' => true,
                    'message' => "Successfully reversed ₹{$creatorPayout} affiliate income for creator {$creatorUserId}.",
                    'reversal_transaction_id' => $revTxId,
                    'status' => 'reversed'
                ]);
            } else {
                // Not settled yet: simple status change to reversed without financial changes
                $upConv = $pdo->prepare('
                    UPDATE affiliate_conversions
                    SET status = "reversed", notes = CONCAT(COALESCE(notes, ""), "\n[Cancelled/Reversed]: ", ?), updated_at = NOW()
                    WHERE id = ?
                ');
                $upConv->execute([$notes ?: 'Cancelled before settlement', $conversionId]);

                $auditStmt = $pdo->prepare('
                    INSERT INTO affiliate_audit_log (id, conversion_id, action, previous_status, new_status, amount_adjusted, performed_by, notes, created_at)
                    VALUES (?, ?, "reversed", ?, "reversed", 0.00, ?, ?, NOW())
                ');
                $auditStmt->execute(['aud_' . bin2hex(random_bytes(16)), $conversionId, $currentStatus, $authUser['user_id'], $notes]);

                $pdo->commit();
                jsonResponse(['success' => true, 'message' => "Conversion marked as reversed (no wallet adjustments were required).", 'status' => 'reversed']);
            }
        }
    } catch (Exception $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        jsonResponse(['success' => false, 'error' => 'Database error executing conversion action: ' . $e->getMessage()], 500);
    }
}

jsonResponse(['success' => false, 'error' => 'Method Not Allowed'], 405);
