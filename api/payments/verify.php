<?php
/**
 * FaceTube - Razorpay Payment Verification & Distribution API (Hostinger / cPanel PHP Production)
 * POST /api/payments/verify.php
 *
 * Security & Reliability Safeguards:
 * 1. Cryptographic HMAC-SHA256 signature verification (Fail-closed if secret missing).
 * 2. Remote Gateway Verification via cURL (Fetches and confirms status & amount from Razorpay).
 * 3. Pre-checkout Order Verification: Compares against server-stored `payment_orders` record.
 * 4. ACID Transaction with row-level locks (FOR UPDATE):
 *    - Atomically updates payment_transactions, payment_orders, uploaded_videos, and wallet_balances.
 * 5. Idempotent Duplicate Handling: Prevents duplicate referral credits and duplicate promotion extensions.
 * 6. Explicit Promotion Renewal Rule: Extends active expiry, otherwise starts from current server time.
 * 7. Safe JSON Responses: Never exposes raw SQL errors, credentials, or internal stack traces.
 */

require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/../response.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['success' => false, 'error' => 'Method Not Allowed'], 405);
}

$pdo = getDatabaseConnection();
$input = getRequestPayload();

$orderId = trim($input['orderId'] ?? ($input['order_id'] ?? ''));
$paymentId = trim($input['paymentId'] ?? ($input['payment_id'] ?? ''));
$signature = trim($input['signature'] ?? '');

if (empty($orderId) || empty($paymentId)) {
    jsonResponse([
        'verified' => false,
        'error' => 'Invalid verification request: orderId and paymentId are required.'
    ], 400);
}

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

// -----------------------------------------------------------------------------
// 1. CRYPTOGRAPHIC SIGNATURE & AUTHENTICATION CHECKS (Fail-Closed)
// -----------------------------------------------------------------------------
$rzpConfig = getRazorpayConfig();
$keyId = $rzpConfig['keyId'];
$secret = $rzpConfig['keySecret'];

if (empty($secret)) {
    error_log('[verify.php] Error: RAZORPAY_KEY_SECRET is not configured on server.');
    jsonResponse([
        'verified' => false,
        'paymentId' => $paymentId,
        'orderId' => $orderId,
        'error' => 'Payment gateway verification is unavailable on server. Please configure RAZORPAY_KEY_SECRET.'
    ], 500);
}

try {
    $authUser = getAuthUser($pdo, true);
} catch (Throwable $authErr) {
    error_log('[verify.php] Auth Database Exception: ' . $authErr->getMessage());
    if ($isConnectionUnavailable($authErr)) {
        jsonResponse([
            'verified' => false,
            'paymentId' => $paymentId,
            'orderId' => $orderId,
            'error' => 'Database connection unavailable during authentication. Please try again.'
        ], 503);
    }
    jsonResponse([
        'verified' => false,
        'paymentId' => $paymentId,
        'orderId' => $orderId,
        'error' => 'Authentication service error during payment verification.'
    ], 500);
}

if (!$authUser) {
    jsonResponse([
        'verified' => false,
        'paymentId' => $paymentId,
        'orderId' => $orderId,
        'error' => 'Authentication required. Please log in to verify payment.'
    ], 401);
}

// Strictly reject synthetic bypasses or empty signatures
if (empty($signature) || $signature === 'mock_signature_bypass' || str_starts_with($signature, 'mock_')) {
    jsonResponse([
        'verified' => false,
        'paymentId' => $paymentId,
        'orderId' => $orderId,
        'error' => 'Payment signature missing or invalid mock signature rejected.'
    ], 400);
}

// Validate HMAC-SHA256 signature
$expectedSignature = hash_hmac('sha256', "{$orderId}|{$paymentId}", $secret);
if (!hash_equals($expectedSignature, $signature)) {
    jsonResponse([
        'verified' => false,
        'paymentId' => $paymentId,
        'orderId' => $orderId,
        'error' => 'Invalid Razorpay payment signature verification failed.'
    ], 400);
}

// Pre-gateway order ownership check (authoritative lock happens inside transaction below)
try {
    $stmtPreOrder = $pdo->prepare('SELECT order_id, user_id, video_id, purpose, plan_id, amount, currency FROM payment_orders WHERE order_id = ? LIMIT 1');
    $stmtPreOrder->execute([$orderId]);
    $preOrder = $stmtPreOrder->fetch();
} catch (Throwable $preOrderErr) {
    error_log('[verify.php] Order pre-lookup error: ' . $preOrderErr->getMessage());
    if ($isConnectionUnavailable($preOrderErr)) {
        jsonResponse(['verified' => false, 'paymentId' => $paymentId, 'orderId' => $orderId, 'error' => 'Database connection unavailable during order lookup.'], 503);
    }
    jsonResponse(['verified' => false, 'paymentId' => $paymentId, 'orderId' => $orderId, 'error' => 'Database error verifying payment order.'], 500);
}

if (!$preOrder) {
    jsonResponse([
        'verified' => false,
        'paymentId' => $paymentId,
        'orderId' => $orderId,
        'error' => 'Payment order not found. Please initiate checkout through a valid server order.'
    ], 404);
}

$isAuthAdmin = isset($authUser['role']) && strtolower((string)$authUser['role']) === 'admin';
if (strcasecmp((string)$preOrder['user_id'], (string)$authUser['user_id']) !== 0 && !$isAuthAdmin) {
    jsonResponse([
        'verified' => false,
        'paymentId' => $paymentId,
        'orderId' => $orderId,
        'error' => 'Unauthorized: Payment order does not belong to the authenticated user.'
    ], 403);
}

// -----------------------------------------------------------------------------
// 2. REMOTE GATEWAY STATUS VERIFICATION VIA RAZORPAY REST API (cURL)
// -----------------------------------------------------------------------------
$ch = curl_init("https://api.razorpay.com/v1/payments/{$paymentId}");
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_USERPWD => "{$keyId}:{$secret}",
    CURLOPT_TIMEOUT => 15,
]);
$pResp = curl_exec($ch);
$pCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$pErr = curl_error($ch);
curl_close($ch);

if ($pResp === false || $pCode < 200 || $pCode >= 300) {
    error_log('[verify.php] Razorpay API lookup error: ' . ($pErr ?: $pResp));
    jsonResponse([
        'verified' => false,
        'paymentId' => $paymentId,
        'orderId' => $orderId,
        'error' => 'Razorpay payment confirmation failed with gateway.',
    ], 400);
}

$pData = json_decode($pResp, true);
if (empty($pData) || !is_array($pData)) {
    jsonResponse([
        'verified' => false,
        'error' => 'Invalid response structure from payment gateway.'
    ], 400);
}

// Verify gateway payment belongs to the expected order
if (!empty($pData['order_id']) && $pData['order_id'] !== $orderId) {
    jsonResponse([
        'verified' => false,
        'error' => "Razorpay payment order mismatch (expected {$orderId}, received {$pData['order_id']})"
    ], 400);
}

// Verify payment currency is strictly INR
if (($pData['currency'] ?? '') !== 'INR') {
    jsonResponse([
        'verified' => false,
        'error' => 'Razorpay payment currency mismatch: expected INR.'
    ], 400);
}

// Verify payment status is successful
if ($pData['status'] !== 'captured' && $pData['status'] !== 'authorized') {
    jsonResponse([
        'verified' => false,
        'error' => "Razorpay payment status is not successful (status: {$pData['status']})."
    ], 400);
}

// If authorized, auto-capture with gateway
if ($pData['status'] === 'authorized') {
    $capAmount = intval($pData['amount']);
    $capCh = curl_init("https://api.razorpay.com/v1/payments/{$paymentId}/capture");
    curl_setopt_array($capCh, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST => true,
        CURLOPT_USERPWD => "{$keyId}:{$secret}",
        CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
        CURLOPT_POSTFIELDS => json_encode(['amount' => $capAmount, 'currency' => 'INR']),
        CURLOPT_TIMEOUT => 15,
    ]);
    $capRes = curl_exec($capCh);
    $capCode = curl_getinfo($capCh, CURLINFO_HTTP_CODE);
    curl_close($capCh);
    if ($capCode < 200 || $capCode >= 300) {
        error_log('[verify.php] Failed to capture authorized payment: ' . $capRes);
        jsonResponse([
            'verified' => false,
            'error' => 'Failed to capture authorized payment on gateway.'
        ], 400);
    }
}

// -----------------------------------------------------------------------------
// 3. ATOMIC DATABASE TRANSACTION & ZERO-TRUST FEATURE UNLOCK
// -----------------------------------------------------------------------------
// Detect optional uploaded_videos / payment_orders columns via INFORMATION_SCHEMA before starting transaction
$hasAdEarningsCol = false;
$hasIsBlockedCol = false;
$hasPromoPaymentIdCol = false;
$hasPromoAppliedAtCol = false;
$hasPtGstCol = false;
$hasPtPgFeeCol = false;
$hasPtRefStatusCol = false;
$hasPtPoolDistCol = false;
$hasPtPoolResCol = false;
$hasPtPoolStatusCol = false;
$hasPremGstCol = false;
$hasPremPgFeeCol = false;
$hasPremRefStatusCol = false;
$hasPremPoolDistCol = false;
$hasPremPoolResCol = false;
$hasPremPoolStatusCol = false;
$hasGlobalPoolReservesTable = false;
try {
    $colStmt = $pdo->query("
        SELECT TABLE_NAME, COLUMN_NAME
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND (
            (TABLE_NAME = 'uploaded_videos' AND COLUMN_NAME IN ('ad_earnings', 'is_blocked', 'promotion_payment_id'))
            OR (TABLE_NAME = 'payment_orders' AND COLUMN_NAME = 'promotion_applied_at')
            OR (TABLE_NAME = 'payment_transactions' AND COLUMN_NAME IN ('gst_amount', 'pg_fee', 'referral_status', 'global_pool_distributed', 'global_pool_reserve', 'global_pool_status'))
            OR (TABLE_NAME = 'premium_transactions' AND COLUMN_NAME IN ('gst_amount', 'pg_fee', 'referral_status', 'global_pool_distributed', 'global_pool_reserve', 'global_pool_status'))
          )
    ");
    if ($colStmt) {
        foreach ($colStmt->fetchAll(PDO::FETCH_ASSOC) as $colRow) {
            $tbl = strtolower((string)($colRow['TABLE_NAME'] ?? ''));
            $normalizedCol = strtolower((string)($colRow['COLUMN_NAME'] ?? ''));
            if ($tbl === 'uploaded_videos') {
                if ($normalizedCol === 'ad_earnings') {
                    $hasAdEarningsCol = true;
                } elseif ($normalizedCol === 'is_blocked') {
                    $hasIsBlockedCol = true;
                } elseif ($normalizedCol === 'promotion_payment_id') {
                    $hasPromoPaymentIdCol = true;
                }
            } elseif ($tbl === 'payment_orders' && $normalizedCol === 'promotion_applied_at') {
                $hasPromoAppliedAtCol = true;
            } elseif ($tbl === 'payment_transactions') {
                if ($normalizedCol === 'gst_amount') {
                    $hasPtGstCol = true;
                } elseif ($normalizedCol === 'pg_fee') {
                    $hasPtPgFeeCol = true;
                } elseif ($normalizedCol === 'referral_status') {
                    $hasPtRefStatusCol = true;
                } elseif ($normalizedCol === 'global_pool_distributed') {
                    $hasPtPoolDistCol = true;
                } elseif ($normalizedCol === 'global_pool_reserve') {
                    $hasPtPoolResCol = true;
                } elseif ($normalizedCol === 'global_pool_status') {
                    $hasPtPoolStatusCol = true;
                }
            } elseif ($tbl === 'premium_transactions') {
                if ($normalizedCol === 'gst_amount') {
                    $hasPremGstCol = true;
                } elseif ($normalizedCol === 'pg_fee') {
                    $hasPremPgFeeCol = true;
                } elseif ($normalizedCol === 'referral_status') {
                    $hasPremRefStatusCol = true;
                } elseif ($normalizedCol === 'global_pool_distributed') {
                    $hasPremPoolDistCol = true;
                } elseif ($normalizedCol === 'global_pool_reserve') {
                    $hasPremPoolResCol = true;
                } elseif ($normalizedCol === 'global_pool_status') {
                    $hasPremPoolStatusCol = true;
                }
            }
        }
    }
} catch (Exception $eColCheck) {
    // Keep safe false defaults if metadata query fails
}
try {
    $tblStmt = $pdo->query("
        SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'global_pool_reserves'
    ");
    if ($tblStmt && count($tblStmt->fetchAll(PDO::FETCH_ASSOC)) > 0) {
        $hasGlobalPoolReservesTable = true;
    }
} catch (Exception $eTblCheck) {
    // Keep safe false default
}
$hasPtAccountingCols = ($hasPtGstCol && $hasPtPgFeeCol && $hasPtRefStatusCol);
$hasPtPoolBreakdownCols = ($hasPtPoolDistCol && $hasPtPoolResCol && $hasPtPoolStatusCol);
$hasPremAccountingCols = ($hasPremGstCol && $hasPremPgFeeCol && $hasPremRefStatusCol);
$hasPremPoolBreakdownCols = ($hasPremPoolDistCol && $hasPremPoolResCol && $hasPremPoolStatusCol);

$safeRollback = static function (PDO $conn): void {
    try {
        if ($conn->inTransaction()) {
            $conn->rollBack();
        }
    } catch (Throwable $_rollbackErr) {
        // Log rollback failure server-side without masking the original exception
        error_log('[verify.php][ROLLBACK] Rollback failed: ' . $_rollbackErr->getMessage());
    }
};

try {
    $pdo->beginTransaction();

    // 3.1 Lock and inspect pre-checkout server order record
    $stmtOrder = $pdo->prepare('SELECT * FROM payment_orders WHERE order_id = ? FOR UPDATE');
    $stmtOrder->execute([$orderId]);
    $orderRecord = $stmtOrder->fetch();

    if (!$orderRecord) {
        $safeRollback($pdo);
        jsonResponse([
            'verified' => false,
            'paymentId' => $paymentId,
            'orderId' => $orderId,
            'error' => 'Payment order not found. Please initiate checkout through a valid server order.'
        ], 404);
    }

    // Authenticated user ownership verification
    $isOrderOwner = strcasecmp((string)$orderRecord['user_id'], (string)$authUser['user_id']) === 0;
    $isAdmin = isset($authUser['role']) && strtolower((string)$authUser['role']) === 'admin';
    if (!$isOrderOwner && !$isAdmin) {
        $safeRollback($pdo);
        jsonResponse(['verified' => false, 'error' => 'Unauthorized: Payment order does not belong to the authenticated user.'], 403);
    }

    $requestedUserId = trim($input['userId'] ?? ($input['user_id'] ?? ''));
    if (!empty($requestedUserId) && strcasecmp((string)$orderRecord['user_id'], $requestedUserId) !== 0) {
        if (!$isAdmin) {
            $safeRollback($pdo);
            jsonResponse(['verified' => false, 'error' => 'Unauthorized: Payment order does not belong to the requested user.'], 403);
        }
    }

    if (strtoupper((string)($orderRecord['currency'] ?? 'INR')) !== 'INR') {
        $safeRollback($pdo);
        jsonResponse(['verified' => false, 'error' => 'Payment order currency mismatch: expected INR.'], 400);
    }

    $requestedPurpose = trim($input['purpose'] ?? '');
    if (!empty($requestedPurpose) && $requestedPurpose !== (string)$orderRecord['purpose']) {
        $safeRollback($pdo);
        jsonResponse(['verified' => false, 'error' => 'Payment purpose does not match the server order record.'], 400);
    }

    $requestedVideoId = trim($input['videoId'] ?? ($input['video_id'] ?? ''));
    $orderVideoId = trim((string)($orderRecord['video_id'] ?? ''));
    if (!empty($orderVideoId) && !empty($requestedVideoId) && $orderVideoId !== $requestedVideoId) {
        $safeRollback($pdo);
        jsonResponse(['verified' => false, 'error' => 'Video ID does not match the server payment order record.'], 400);
    }

    // Fast-path duplicate check: Order is already marked paid
    if ($orderRecord['status'] === 'paid') {
        if (!empty($orderRecord['payment_id']) && (string)$orderRecord['payment_id'] !== $paymentId) {
            $safeRollback($pdo);
            jsonResponse([
                'verified' => false,
                'paymentId' => $paymentId,
                'orderId' => $orderId,
                'error' => 'Conflict: Payment order was already settled with a different payment ID.'
            ], 409);
        }

        $existingSub = null;
        if ($orderRecord['purpose'] === 'paid_subscription') {
            try {
                $stmtSub = $pdo->prepare('SELECT * FROM user_subscriptions WHERE payment_id = ? OR order_id = ? LIMIT 1');
                $stmtSub->execute([$paymentId, $orderId]);
                $subRow = $stmtSub->fetch();
                if ($subRow) {
                    $existingSub = [
                        'subscriptionId' => $subRow['subscription_id'],
                        'userId' => $subRow['user_id'],
                        'planId' => $subRow['plan_id'],
                        'orderId' => $subRow['order_id'],
                        'paymentId' => $subRow['payment_id'],
                        'amount' => floatval($subRow['amount']),
                        'currency' => $subRow['currency'],
                        'status' => $subRow['status'],
                        'startsAt' => $subRow['starts_at'],
                        'expiresAt' => $subRow['expires_at'],
                    ];
                }
            } catch (Exception $eSub) {
                // ignore
            }
        }
        $safeRollback($pdo);
        $duplicateResp = [
            'verified' => true,
            'paymentId' => $paymentId,
            'orderId' => $orderId,
            'amount' => floatval($orderRecord['amount']),
            'purpose' => $orderRecord['purpose'],
            'duplicate' => true,
            'message' => 'Payment already verified and credited previously (idempotent duplicate).'
        ];
        if ($existingSub) {
            $duplicateResp['subscription'] = $existingSub;
        }
        jsonResponse($duplicateResp);
        exit;
    }

    // Authoritative parameters locked from server-stored order
    $userId = (string)$orderRecord['user_id'];
    $userName = (string)($orderRecord['user_name'] ?? 'Creator');
    $videoId = !empty($orderVideoId) ? $orderVideoId : $requestedVideoId;
    $purpose = (string)$orderRecord['purpose'];
    $planId = trim((string)($orderRecord['plan_id'] ?? ''));
    $amount = floatval($orderRecord['amount']);

    // Verify authoritative pricing against order purpose/plan
    $authoritativeAmount = 6.00;
    if ($purpose === 'ads_promotion') {
        $pricing = ['plan-7-days' => 100.0, 'plan-15-days' => 200.0, 'plan-monthly' => 300.0, 'plan-yearly' => 3000.0];
        if (empty($planId)) {
            $planId = 'plan-monthly';
        }
        if (!isset($pricing[$planId])) {
            $safeRollback($pdo);
            jsonResponse(['verified' => false, 'error' => 'Invalid ads promotion plan in order record.'], 400);
        }
        $authoritativeAmount = $pricing[$planId];
    } elseif ($purpose === 'paid_subscription') {
        $baselinePlanPricing = [
            'member-monthly' => ['price' => 49.00, 'duration' => 30],
            'member-vip-monthly' => ['price' => 149.00, 'duration' => 30],
            'member-annual' => ['price' => 999.00, 'duration' => 365],
        ];
        $planFound = false;
        try {
            $stmtPlan = $pdo->prepare('SELECT price, duration_days FROM subscriber_plans WHERE plan_id = ? LIMIT 1');
            $stmtPlan->execute([$planId]);
            $planRow = $stmtPlan->fetch();
            if ($planRow) {
                $authoritativeAmount = floatval($planRow['price']);
                $planFound = true;
            }
        } catch (Exception $ePlan) {
            // fallback
        }
        if (!$planFound) {
            if (!isset($baselinePlanPricing[$planId])) {
                $safeRollback($pdo);
                jsonResponse(['verified' => false, 'error' => 'Invalid subscriber plan in order record.'], 400);
            }
            $authoritativeAmount = $baselinePlanPricing[$planId]['price'];
        }
    } elseif ($purpose !== 'premium_video_upload') {
        $safeRollback($pdo);
        jsonResponse(['verified' => false, 'error' => 'Unsupported payment purpose in order record.'], 400);
    }

    if (abs($amount - $authoritativeAmount) > 0.01) {
        $safeRollback($pdo);
        jsonResponse(['verified' => false, 'error' => 'Payment order amount does not match authoritative pricing.'], 400);
    }

    if (isset($input['amount']) && is_numeric($input['amount']) && abs(floatval($input['amount']) - $amount) > 0.01) {
        $safeRollback($pdo);
        jsonResponse([
            'verified' => false,
            'error' => "Payment amount ₹{$input['amount']} does not match expected fee of ₹" . number_format($amount, 2, '.', '') . "."
        ], 400);
    }

    // Verify gateway amount matches server authoritative amount (in paise)
    $expectedSubunits = (int)round($amount * 100);
    if ((int)($pData['amount'] ?? 0) !== $expectedSubunits) {
        $safeRollback($pdo);
        jsonResponse([
            'verified' => false,
            'error' => "Payment amount mismatch: expected ₹{$amount}, received " . (($pData['amount'] ?? 0) / 100)
        ], 400);
    }

    // 3.2 Lock check for duplicate or reused payment_id in payment_transactions
    $stmtExisting = $pdo->prepare('SELECT * FROM payment_transactions WHERE payment_id = ? FOR UPDATE');
    $stmtExisting->execute([$paymentId]);
    $existingTx = $stmtExisting->fetch();
    if ($existingTx) {
        $txOrderMismatch = !empty($existingTx['order_id']) && (string)$existingTx['order_id'] !== $orderId;
        $txUserMismatch = strcasecmp((string)$existingTx['user_id'], $userId) !== 0;
        $txVideoMismatch = !empty($videoId) && !empty($existingTx['video_id']) && (string)$existingTx['video_id'] !== $videoId;
        if ($txOrderMismatch || $txUserMismatch || $txVideoMismatch || (string)$existingTx['purpose'] !== $purpose) {
            $safeRollback($pdo);
            jsonResponse([
                'verified' => false,
                'paymentId' => $paymentId,
                'orderId' => $orderId,
                'error' => 'Conflict: Payment ID has already been used for a different order, video, or user.'
            ], 409);
        }

        $existingSub = null;
        if ($existingTx['purpose'] === 'paid_subscription') {
            try {
                $stmtSub = $pdo->prepare('SELECT * FROM user_subscriptions WHERE payment_id = ? OR order_id = ? LIMIT 1');
                $stmtSub->execute([$paymentId, $orderId]);
                $subRow = $stmtSub->fetch();
                if ($subRow) {
                    $existingSub = [
                        'subscriptionId' => $subRow['subscription_id'],
                        'userId' => $subRow['user_id'],
                        'planId' => $subRow['plan_id'],
                        'orderId' => $subRow['order_id'],
                        'paymentId' => $subRow['payment_id'],
                        'amount' => floatval($subRow['amount']),
                        'currency' => $subRow['currency'],
                        'status' => $subRow['status'],
                        'startsAt' => $subRow['starts_at'],
                        'expiresAt' => $subRow['expires_at'],
                    ];
                }
            } catch (Exception $eSub) {
                // ignore
            }
        }
        $safeRollback($pdo);
        $duplicateResp = [
            'verified' => true,
            'paymentId' => $existingTx['payment_id'],
            'orderId' => $existingTx['order_id'],
            'amount' => floatval($existingTx['amount']),
            'purpose' => $existingTx['purpose'],
            'txNumber' => intval($existingTx['tx_number']),
            'isSpecialTransaction' => (bool)$existingTx['is_special'],
            'specialTag' => $existingTx['special_tag'],
            'duplicate' => true,
            'message' => 'Payment already verified and credited previously (idempotent duplicate).'
        ];
        if ($existingTx['purpose'] === 'premium_video_upload') {
            $dupGst = isset($existingTx['gst_amount']) && floatval($existingTx['gst_amount']) > 0 ? floatval($existingTx['gst_amount']) : 0.90;
            $dupPg = isset($existingTx['pg_fee']) && floatval($existingTx['pg_fee']) > 0 ? floatval($existingTx['pg_fee']) : 0.10;
            $dupRefStatus = !empty($existingTx['referral_status']) && $existingTx['referral_status'] !== 'not_applicable'
                ? (string)$existingTx['referral_status']
                : (floatval($existingTx['referral_commission'] ?? 0) > 0 ? 'credited' : 'unassigned_pending');
            $dupPoolAllocated = floatval($existingTx['global_pool_allocation']);
            $dupPoolDistributed = isset($existingTx['global_pool_distributed'])
                ? floatval($existingTx['global_pool_distributed'])
                : $dupPoolAllocated;
            $dupPoolReserve = isset($existingTx['global_pool_reserve'])
                ? floatval($existingTx['global_pool_reserve'])
                : max(0.0, round($dupPoolAllocated - $dupPoolDistributed, 2));
            $dupPoolStatus = !empty($existingTx['global_pool_status']) && $existingTx['global_pool_status'] !== 'not_applicable'
                ? (string)$existingTx['global_pool_status']
                : ($dupPoolReserve <= 0 ? 'settled' : ($dupPoolDistributed <= 0 ? 'pending_reserve' : 'partial_reserve'));
            $duplicateResp['distribution'] = [
                'directReferralAmount' => floatval($existingTx['referral_commission']),
                'referralStatus' => $dupRefStatus,
                'adminAmount' => floatval($existingTx['admin_allocation']),
                'globalPoolAmount' => $dupPoolAllocated,
                'globalPoolDistributedAmount' => $dupPoolDistributed,
                'globalPoolReserveAmount' => $dupPoolReserve,
                'globalPoolStatus' => $dupPoolStatus,
                'gstAmount' => $dupGst,
                'pgFeeAmount' => $dupPg,
                'taxAndFees' => round($dupGst + $dupPg, 2),
                'totalAmount' => floatval($existingTx['amount']),
            ];
        }
        if ($existingSub) {
            $duplicateResp['subscription'] = $existingSub;
        }
        jsonResponse($duplicateResp);
        exit;
    }

    // Video ownership & anti-reuse verification under row lock
    $lockedVideoRow = null;
    if (!empty($videoId)) {
        $promoPaySelect = $hasPromoPaymentIdCol ? ', promotion_payment_id' : '';
        $stmtVidLock = $pdo->prepare("SELECT id, user_id, video_type, payment_status, payment_id{$promoPaySelect} FROM uploaded_videos WHERE id = ? FOR UPDATE");
        $stmtVidLock->execute([$videoId]);
        $lockedVideoRow = $stmtVidLock->fetch();
        if ($lockedVideoRow) {
            if (strcasecmp((string)$lockedVideoRow['user_id'], $userId) !== 0 && !$isAdmin) {
                $safeRollback($pdo);
                jsonResponse([
                    'verified' => false,
                    'error' => 'Unauthorized: Video record does not belong to the authenticated payer.'
                ], 403);
            }
            if ($purpose === 'premium_video_upload' && strtolower((string)($lockedVideoRow['video_type'] ?? '')) === 'free') {
                $safeRollback($pdo);
                jsonResponse([
                    'verified' => false,
                    'error' => 'Free video uploads do not require payment or commission.'
                ], 400);
            }
        } elseif ($purpose === 'ads_promotion') {
            $safeRollback($pdo);
            jsonResponse([
                'verified' => false,
                'error' => 'Video not found for ads promotion.'
            ], 404);
        }

        if ($purpose === 'premium_video_upload') {
            $stmtReuseVid = $pdo->prepare('SELECT id FROM uploaded_videos WHERE payment_id = ? AND id != ? LIMIT 1');
            $stmtReuseVid->execute([$paymentId, $videoId]);
            if ($stmtReuseVid->fetch()) {
                $safeRollback($pdo);
                jsonResponse([
                    'verified' => false,
                    'error' => 'Conflict: Payment ID is already linked to another video.'
                ], 409);
            }
        }
    } elseif ($purpose === 'ads_promotion') {
        $safeRollback($pdo);
        jsonResponse([
            'verified' => false,
            'error' => 'Video ID is required for ads promotion.'
        ], 400);
    }

    $createdSubscription = null;
    $isPremiumUpload = ($purpose === 'premium_video_upload');
    $gstAmount = 0.00;
    $pgFeeAmount = 0.00;
    $taxAndFees = 0.00;
    $referralStatus = 'not_applicable';
    $globalPoolDistributed = 0.00;
    $globalPoolReserve = 0.00;
    $globalPoolStatus = 'not_applicable';
    $globalPoolReserveReason = null;
    $globalPoolReserveId = null;
    $creatorPayouts = [];
    $eligibleCreatorCount = 0;

    if ($isPremiumUpload) {
        // 3.3 Premium Video sequence allocation under row lock (isolating counter to premium uploads only)
        $stmtCount = $pdo->query("SELECT COUNT(*) as total FROM payment_transactions WHERE purpose = 'premium_video_upload' FOR UPDATE");
        $countRow = $stmtCount->fetch();
        $txNumber = intval($countRow['total'] ?? 0) + 1;

        // Uniform Phase 1.1 ₹6 business rule for every premium transaction (including #11, #21, #31, #41...):
        // - Referral allocation: ₹1.00 ('credited' to referrer OR 'unassigned_pending' if no valid referrer)
        // - Admin allocation: ₹1.00 ALWAYS (never receives 0-eligible fallback or rounding residual paise)
        // - GST + Payment Gateway: ₹1.00 (GST ₹0.90 + PG Fee ₹0.10)
        // - Global Distribution Pool: ₹3.00 ALWAYS (distributed + pending reserve = ₹3.00)
        $isSpecial = false;
        $specialTag = 'NORMAL_PREMIUM';

        // Verify direct referral sponsor strictly from users table
        $verifiedReferrerId = null;
        $stmtUserRef = $pdo->prepare('SELECT id, referral_code FROM users WHERE UPPER(user_id) = UPPER(?) LIMIT 1');
        $stmtUserRef->execute([$userId]);
        $userRow = $stmtUserRef->fetch();
        $refCode = trim($userRow['referral_code'] ?? '');

        if (!empty($refCode)) {
            $stmtRef = $pdo->prepare('
                SELECT user_id FROM users 
                WHERE (UPPER(user_id) = UPPER(?) OR UPPER(referral_code) = UPPER(?)) 
                  AND UPPER(user_id) != UPPER(?) 
                LIMIT 1
            ');
            $stmtRef->execute([$refCode, $refCode, $userId]);
            $refMatch = $stmtRef->fetch();
            if ($refMatch) {
                $verifiedReferrerId = $refMatch['user_id'];
            }
        }

        // Resolve Admin user identifier from database
        $stmtAdmin = $pdo->query("SELECT user_id FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1");
        $adminRow = $stmtAdmin->fetch();
        $adminUserId = $adminRow['user_id'] ?? 'FT102857';

        $hasReferrer = !empty($verifiedReferrerId);
        $referralCommission = 1.00;
        $referralStatus = $hasReferrer ? 'credited' : 'unassigned_pending';
        $adminAllocation = 1.00;
        $globalPoolAllocation = 3.00;
        $gstAmount = 0.90;
        $pgFeeAmount = 0.10;
        $taxAndFees = 1.00;

        $creatorPayouts = [];
        $eligibleCreatorCount = 0;

        // Per-video weighted Ads Earnings Share distribution of the ₹3.00 pool (300 paise).
        // Query eligible previous videos from uploaded_videos, strictly excluding videos by the current uploader:
        $adEarningsExpr = $hasAdEarningsCol ? 'COALESCE(ad_earnings, 0.00) AS ad_earnings' : '0.00 AS ad_earnings';
        $blockedFilter = $hasIsBlockedCol ? "\n                  AND (is_blocked = 0 OR is_blocked IS NULL)" : '';
        $stmtEligibleVideos = $pdo->prepare('
            SELECT id AS video_id, user_id, ' . $adEarningsExpr . '
            FROM uploaded_videos
            WHERE (video_type = "premium" OR payment_status = "paid")
              AND UPPER(user_id) != UPPER(?)' . $blockedFilter . '
            ORDER BY created_at ASC, id ASC
        ');
        $stmtEligibleVideos->execute([$userId]);
        $eligibleVideos = $stmtEligibleVideos->fetchAll(PDO::FETCH_ASSOC);
        $eligibleVideoCount = count($eligibleVideos);
        $eligibleCreatorCount = $eligibleVideoCount;

        $poolPaise = 300;
        $distributedPaise = 0;
        $reservePaise = $poolPaise;

        if ($eligibleVideoCount === 0) {
            // Zero eligible previous videos: hold entire ₹3.00 in pending Global Pool reserve
            $distributedPaise = 0;
            $reservePaise = $poolPaise;
        } else {
            // Scale DECIMAL(14,4) ad_earnings to integer micro-units (x 10,000) to avoid IEEE 754 float drift
            $scaledUnits = [];
            $totalUnits = 0;
            foreach ($eligibleVideos as $idx => $ev) {
                $units = (int)round(max(0.0, floatval($ev['ad_earnings'] ?? 0)) * 10000);
                $scaledUnits[$idx] = $units;
                $totalUnits += $units;
            }

            if ($totalUnits > 0) {
                $allocatedPaise = 0;
                foreach ($eligibleVideos as $idx => $ev) {
                    $units = $scaledUnits[$idx];
                    $amountPaise = intdiv($units * $poolPaise, $totalUnits);
                    $allocatedPaise += $amountPaise;

                    $creatorPayouts[] = [
                        'userId' => $ev['user_id'],
                        'videoId' => $ev['video_id'],
                        'amount' => $amountPaise / 100,
                        'amountPaise' => $amountPaise,
                        'weight' => $units / $totalUnits,
                        'adEarnings' => max(0.0, floatval($ev['ad_earnings'] ?? 0)),
                    ];
                }
                $distributedPaise = $allocatedPaise;
                $reservePaise = max(0, $poolPaise - $allocatedPaise);
            } else {
                // Fallback to equal per-video integer distribution if total ad earnings is 0
                $perVideoPaise = intdiv($poolPaise, $eligibleVideoCount);
                $distributedPaise = $perVideoPaise * $eligibleVideoCount;
                $reservePaise = $poolPaise - $distributedPaise;

                foreach ($eligibleVideos as $ev) {
                    $creatorPayouts[] = [
                        'userId' => $ev['user_id'],
                        'videoId' => $ev['video_id'],
                        'amount' => $perVideoPaise / 100,
                        'amountPaise' => $perVideoPaise,
                        'weight' => 1 / $eligibleVideoCount,
                        'adEarnings' => 0.0,
                    ];
                }
            }
        }

        $globalPoolDistributed = $distributedPaise / 100;
        $globalPoolReserve = $reservePaise / 100;
        $globalPoolStatus = ($reservePaise === 0)
            ? 'settled'
            : (($distributedPaise === 0) ? 'pending_reserve' : 'partial_reserve');
        $globalPoolReserveReason = ($reservePaise === 0)
            ? null
            : (($distributedPaise === 0) ? 'no_eligible_videos' : 'rounding_residual');

        // Insert into payment_transactions (protected by UNIQUE key on payment_id)
        if ($hasPtAccountingCols && $hasPtPoolBreakdownCols) {
            $stmtTx = $pdo->prepare('
                INSERT INTO payment_transactions (
                    order_id, payment_id, user_id, user_name, video_id, purpose, amount,
                    tx_number, is_special, special_tag, referral_commission, admin_allocation, global_pool_allocation,
                    global_pool_distributed, global_pool_reserve, global_pool_status,
                    gst_amount, pg_fee, referral_status, created_at
                ) VALUES (
                    ?, ?, ?, ?, ?, ?, ?,
                    ?, 0, ?, ?, ?, ?,
                    ?, ?, ?,
                    ?, ?, ?, NOW()
                )
            ');
            $stmtTx->execute([
                $orderId, $paymentId, $userId, $userName, $videoId ?: null, $purpose, $amount,
                $txNumber, $specialTag, $referralCommission, $adminAllocation, $globalPoolAllocation,
                $globalPoolDistributed, $globalPoolReserve, $globalPoolStatus,
                $gstAmount, $pgFeeAmount, $referralStatus
            ]);
        } elseif ($hasPtAccountingCols) {
            $stmtTx = $pdo->prepare('
                INSERT INTO payment_transactions (
                    order_id, payment_id, user_id, user_name, video_id, purpose, amount,
                    tx_number, is_special, special_tag, referral_commission, admin_allocation, global_pool_allocation,
                    gst_amount, pg_fee, referral_status, created_at
                ) VALUES (
                    ?, ?, ?, ?, ?, ?, ?,
                    ?, 0, ?, ?, ?, ?,
                    ?, ?, ?, NOW()
                )
            ');
            $stmtTx->execute([
                $orderId, $paymentId, $userId, $userName, $videoId ?: null, $purpose, $amount,
                $txNumber, $specialTag, $referralCommission, $adminAllocation, $globalPoolAllocation,
                $gstAmount, $pgFeeAmount, $referralStatus
            ]);
        } else {
            $stmtTx = $pdo->prepare('
                INSERT INTO payment_transactions (
                    order_id, payment_id, user_id, user_name, video_id, purpose, amount,
                    tx_number, is_special, special_tag, referral_commission, admin_allocation, global_pool_allocation,
                    created_at
                ) VALUES (
                    ?, ?, ?, ?, ?, ?, ?,
                    ?, 0, ?, ?, ?, ?,
                    NOW()
                )
            ');
            $stmtTx->execute([
                $orderId, $paymentId, $userId, $userName, $videoId ?: null, $purpose, $amount,
                $txNumber, $specialTag, $referralCommission, $adminAllocation, $globalPoolAllocation
            ]);
        }

        // Insert into premium_transactions audit sequence
        try {
            $ptId = sprintf('%04x%04x-%04x-%04x-%04x-%04x%04x%04x',
                mt_rand(0, 0xffff), mt_rand(0, 0xffff), mt_rand(0, 0xffff),
                mt_rand(0, 0x0fff) | 0x4000, mt_rand(0, 0x3fff) | 0x8000,
                mt_rand(0, 0xffff), mt_rand(0, 0xffff), mt_rand(0, 0xffff));
            if ($hasPremAccountingCols && $hasPremPoolBreakdownCols) {
                $stmtPt = $pdo->prepare('
                    INSERT INTO premium_transactions (
                        id, tx_number, payment_id, order_id, video_id, user_id, referrer_id,
                        amount, transaction_type, is_special, special_tag, referral_commission,
                        admin_allocation, global_pool_allocation, global_pool_distributed, global_pool_reserve, global_pool_status,
                        gst_amount, pg_fee, referral_status, created_at
                    ) VALUES (
                        ?, ?, ?, ?, ?, ?, ?,
                        ?, "premium_upload", 0, ?, ?,
                        ?, ?, ?, ?, ?,
                        ?, ?, ?, NOW()
                    )
                ');
                $stmtPt->execute([
                    $ptId, $txNumber, $paymentId, $orderId, $videoId ?: 'vid_unknown', $userId, $verifiedReferrerId,
                    $amount, $specialTag, $referralCommission,
                    $adminAllocation, $globalPoolAllocation, $globalPoolDistributed, $globalPoolReserve, $globalPoolStatus,
                    $gstAmount, $pgFeeAmount, $referralStatus
                ]);
            } elseif ($hasPremAccountingCols) {
                $stmtPt = $pdo->prepare('
                    INSERT INTO premium_transactions (
                        id, tx_number, payment_id, order_id, video_id, user_id, referrer_id,
                        amount, transaction_type, is_special, special_tag, referral_commission,
                        admin_allocation, global_pool_allocation, gst_amount, pg_fee, referral_status, created_at
                    ) VALUES (
                        ?, ?, ?, ?, ?, ?, ?,
                        ?, "premium_upload", 0, ?, ?,
                        ?, ?, ?, ?, ?, NOW()
                    )
                ');
                $stmtPt->execute([
                    $ptId, $txNumber, $paymentId, $orderId, $videoId ?: 'vid_unknown', $userId, $verifiedReferrerId,
                    $amount, $specialTag, $referralCommission,
                    $adminAllocation, $globalPoolAllocation, $gstAmount, $pgFeeAmount, $referralStatus
                ]);
            } else {
                $stmtPt = $pdo->prepare('
                    INSERT INTO premium_transactions (
                        id, tx_number, payment_id, order_id, video_id, user_id, referrer_id,
                        amount, transaction_type, is_special, special_tag, referral_commission,
                        admin_allocation, global_pool_allocation, created_at
                    ) VALUES (
                        ?, ?, ?, ?, ?, ?, ?,
                        ?, "premium_upload", 0, ?, ?,
                        ?, ?, NOW()
                    )
                ');
                $stmtPt->execute([
                    $ptId, $txNumber, $paymentId, $orderId, $videoId ?: 'vid_unknown', $userId, $verifiedReferrerId,
                    $amount, $specialTag, $referralCommission,
                    $adminAllocation, $globalPoolAllocation
                ]);
            }
        } catch (Exception $ePt) {
            // Table optional
        }

        // 1. Direct referral commission (₹1.00)
        // If valid referrer: credit income_ledger (settled) & wallet_balances (+₹1.00).
        // If no valid referrer: preserve ₹1.00 in explicit 'unassigned_pending' ledger entry without crediting Admin or fake wallets.
        if (!empty($verifiedReferrerId)) {
            $txRefId = 'TX_REF_' . $paymentId;
            $ledgerUuid = sprintf('%04x%04x-%04x-%04x-%04x-%04x%04x%04x',
                mt_rand(0, 0xffff), mt_rand(0, 0xffff), mt_rand(0, 0xffff),
                mt_rand(0, 0x0fff) | 0x4000, mt_rand(0, 0x3fff) | 0x8000,
                mt_rand(0, 0xffff), mt_rand(0, 0xffff), mt_rand(0, 0xffff));

            $stmtLedger = $pdo->prepare('
                INSERT INTO income_ledger (
                    id, transaction_id, user_id, source_user_id, source_user_name, video_id,
                    income_type, amount, status, special_tag, description, created_at
                ) VALUES (
                    ?, ?, ?, ?, ?, ?,
                    "referral_income", 1.0000, "settled", ?, ?, NOW()
                )
            ');
            $stmtLedger->execute([
                $ledgerUuid,
                $txRefId,
                $verifiedReferrerId,
                $userId,
                $userName,
                $videoId ?: null,
                $specialTag,
                "Direct referral commission (₹1.00) for eligible Premium Video upload by {$userName} ({$userId})"
            ]);

            $stmtCredit = $pdo->prepare('
                INSERT INTO wallet_balances (user_id, balance, total_earned, total_withdrawn, referral_income, global_income, adsense_income, affiliate_income, updated_at)
                VALUES (?, 1.00, 1.00, 0.00, 1.00, 0.00, 0.00, 0.00, NOW())
                ON DUPLICATE KEY UPDATE
                    balance = balance + 1.00,
                    total_earned = total_earned + 1.00,
                    referral_income = referral_income + 1.00,
                    updated_at = NOW()
            ');
            $stmtCredit->execute([$verifiedReferrerId]);
        } else {
            $txRefPendingId = 'TX_REF_PENDING_' . $paymentId;
            $pendingLedgerUuid = sprintf('%04x%04x-%04x-%04x-%04x-%04x%04x%04x',
                mt_rand(0, 0xffff), mt_rand(0, 0xffff), mt_rand(0, 0xffff),
                mt_rand(0, 0x0fff) | 0x4000, mt_rand(0, 0x3fff) | 0x8000,
                mt_rand(0, 0xffff), mt_rand(0, 0xffff), mt_rand(0, 0xffff));

            $stmtPendingRefLedger = $pdo->prepare('
                INSERT INTO income_ledger (
                    id, transaction_id, user_id, source_user_id, source_user_name, video_id,
                    income_type, amount, status, special_tag, description, created_at
                ) VALUES (
                    ?, ?, "UNASSIGNED_REFERRAL", ?, ?, ?,
                    "referral_income", 1.0000, "pending", "REFERRAL_UNASSIGNED_PENDING", ?, NOW()
                )
            ');
            $stmtPendingRefLedger->execute([
                $pendingLedgerUuid,
                $txRefPendingId,
                $userId,
                $userName,
                $videoId ?: null,
                "Unassigned referral allocation (₹1.00 pending) — no valid referrer for Premium Video #{$txNumber} upload by {$userName} ({$userId})"
            ]);
        }

        // 2. Credit Admin allocation (strictly ₹1.00) in income_ledger and wallet_balances
        if ($adminAllocation > 0) {
            $txAdmId = 'TX_ADM_' . $paymentId;
            $admLedgerUuid = sprintf('%04x%04x-%04x-%04x-%04x-%04x%04x%04x',
                mt_rand(0, 0xffff), mt_rand(0, 0xffff), mt_rand(0, 0xffff),
                mt_rand(0, 0x0fff) | 0x4000, mt_rand(0, 0x3fff) | 0x8000,
                mt_rand(0, 0xffff), mt_rand(0, 0xffff), mt_rand(0, 0xffff));
            $admDesc = "Admin Allocation (₹{$adminAllocation}) for Premium Video #{$txNumber} upload by {$userName} ({$userId})";

            $stmtAdmLedger = $pdo->prepare('
                INSERT INTO income_ledger (
                    id, transaction_id, user_id, source_user_id, source_user_name, video_id,
                    income_type, amount, status, special_tag, description, created_at
                ) VALUES (
                    ?, ?, ?, ?, ?, ?,
                    "admin_allocation", ?, "settled", ?, ?, NOW()
                )
            ');
            $stmtAdmLedger->execute([
                $admLedgerUuid,
                $txAdmId,
                $adminUserId,
                $userId,
                $userName,
                $videoId ?: null,
                $adminAllocation,
                $specialTag,
                $admDesc
            ]);

            $stmtCreditAdmin = $pdo->prepare('
                INSERT INTO wallet_balances (user_id, balance, total_earned, total_withdrawn, referral_income, global_income, adsense_income, affiliate_income, updated_at)
                VALUES (?, ?, ?, 0.00, 0.00, 0.00, 0.00, 0.00, NOW())
                ON DUPLICATE KEY UPDATE
                    balance = balance + VALUES(balance),
                    total_earned = total_earned + VALUES(total_earned),
                    updated_at = NOW()
            ');
            $stmtCreditAdmin->execute([$adminUserId, $adminAllocation, $adminAllocation]);
        }

        // 3. Credit each distinct eligible previous creator with their global income share
        if (!empty($creatorPayouts)) {
            $stmtGlbLedger = $pdo->prepare('
                INSERT INTO income_ledger (
                    id, transaction_id, user_id, source_user_id, source_user_name, video_id,
                    income_type, amount, status, special_tag, description, created_at
                ) VALUES (
                    ?, ?, ?, ?, ?, ?,
                    "global_income", ?, "settled", ?, ?, NOW()
                )
            ');
            $stmtCreditCreator = $pdo->prepare('
                INSERT INTO wallet_balances (user_id, balance, total_earned, total_withdrawn, referral_income, global_income, adsense_income, affiliate_income, updated_at)
                VALUES (?, ?, ?, 0.00, 0.00, ?, 0.00, 0.00, NOW())
                ON DUPLICATE KEY UPDATE
                    balance = balance + VALUES(balance),
                    total_earned = total_earned + VALUES(total_earned),
                    global_income = global_income + VALUES(global_income),
                    updated_at = NOW()
            ');

            foreach ($creatorPayouts as $payout) {
                if ($payout['amount'] <= 0) {
                    continue;
                }
                $txGlbId = "TX_GLB_{$paymentId}_{$payout['videoId']}";
                $glbUuid = sprintf('%04x%04x-%04x-%04x-%04x-%04x%04x%04x',
                    mt_rand(0, 0xffff), mt_rand(0, 0xffff), mt_rand(0, 0xffff),
                    mt_rand(0, 0x0fff) | 0x4000, mt_rand(0, 0x3fff) | 0x8000,
                    mt_rand(0, 0xffff), mt_rand(0, 0xffff), mt_rand(0, 0xffff));
                $glbDesc = "Per-Video Ads Earnings Share for video #{$payout['videoId']} (₹{$payout['amount']} share of ₹3 pool for Premium Video #{$txNumber})";

                $stmtGlbLedger->execute([
                    $glbUuid,
                    $txGlbId,
                    $payout['userId'],
                    $userId,
                    $userName,
                    $payout['videoId'], // Record the exact rewarded video_id in income_ledger
                    $payout['amount'],
                    $specialTag,
                    $glbDesc
                ]);

                $stmtCreditCreator->execute([
                    $payout['userId'],
                    $payout['amount'],
                    $payout['amount'],
                    $payout['amount']
                ]);
            }
        }

        // 3b. Preserve any unallocated ₹3.00 or rounding residual in Global Pool pending reserve
        if ($reservePaise > 0 && $globalPoolReserveReason !== null) {
            $txGlbReserveId = 'TX_GLB_RESERVE_' . $paymentId;
            $glbResLedgerUuid = sprintf('%04x%04x-%04x-%04x-%04x-%04x%04x%04x',
                mt_rand(0, 0xffff), mt_rand(0, 0xffff), mt_rand(0, 0xffff),
                mt_rand(0, 0x0fff) | 0x4000, mt_rand(0, 0x3fff) | 0x8000,
                mt_rand(0, 0xffff), mt_rand(0, 0xffff), mt_rand(0, 0xffff));
            $reserveDesc = ($globalPoolReserveReason === 'no_eligible_videos')
                ? "Global Pool pending reserve (₹{$globalPoolReserve} — 0 eligible previous videos for Premium Video #{$txNumber})"
                : "Global Pool pending reserve (₹{$globalPoolReserve} — integer-paise rounding residual for Premium Video #{$txNumber})";

            $stmtGlbResLedger = $pdo->prepare('
                INSERT INTO income_ledger (
                    id, transaction_id, user_id, source_user_id, source_user_name, video_id,
                    income_type, amount, status, special_tag, description, created_at
                ) VALUES (
                    ?, ?, "GLOBAL_POOL_RESERVE", ?, ?, ?,
                    "global_income", ?, "pending", "GLOBAL_POOL_PENDING_RESERVE", ?, NOW()
                )
            ');
            $stmtGlbResLedger->execute([
                $glbResLedgerUuid,
                $txGlbReserveId,
                $userId,
                $userName,
                $videoId ?: null,
                $globalPoolReserve,
                $reserveDesc
            ]);

            if ($hasGlobalPoolReservesTable) {
                $globalPoolReserveId = 'gpr_' . round(microtime(true) * 1000) . '_' . substr(bin2hex(random_bytes(4)), 0, 8);
                $stmtReserve = $pdo->prepare('
                    INSERT INTO global_pool_reserves (
                        id, payment_id, order_id, tx_number, source_user_id, source_video_id,
                        reserve_amount, reserve_paise, reserve_reason, status, notes, created_at, updated_at
                    ) VALUES (
                        ?, ?, ?, ?, ?, ?,
                        ?, ?, ?, "pending", ?, NOW(), NOW()
                    )
                ');
                $stmtReserve->execute([
                    $globalPoolReserveId,
                    $paymentId,
                    $orderId,
                    $txNumber,
                    strtoupper($userId),
                    $videoId ?: null,
                    $globalPoolReserve,
                    $reservePaise,
                    $globalPoolReserveReason,
                    $reserveDesc
                ]);
            }
        }

        $levelPayouts = [];
        $missingLevels = [];
        $adminPercent = intval(round(($adminAllocation / $amount) * 100));
        $totalReferralAmount = $referralCommission;
    } elseif ($purpose === 'paid_subscription') {
        $txNumber = 0;
        $isSpecial = false;
        $specialTag = 'PAID_SUBSCRIPTION';
        $globalPoolAllocation = 0.00;
        $referralCommission = 0.00;
        $adminAllocation = 0.00;

        // Authoritative plan resolution from subscriber_plans table
        $durationDays = 30;
        $planFound = false;
        try {
            $stmtPlan = $pdo->prepare('SELECT price, duration_days, is_active FROM subscriber_plans WHERE plan_id = ? LIMIT 1');
            $stmtPlan->execute([$planId]);
            $planRow = $stmtPlan->fetch();
            if ($planRow) {
                $amount = floatval($planRow['price']);
                $durationDays = intval($planRow['duration_days'] ?: 30);
                $planFound = true;
            }
        } catch (Exception $ePlan) {
            // fallback if table unmigrated
        }
        if (!$planFound) {
            $baselinePlanPricing = [
                'member-monthly' => ['price' => 49.00, 'duration' => 30],
                'member-vip-monthly' => ['price' => 149.00, 'duration' => 30],
                'member-annual' => ['price' => 999.00, 'duration' => 365],
            ];
            if (isset($baselinePlanPricing[$planId])) {
                $amount = $baselinePlanPricing[$planId]['price'];
                $durationDays = $baselinePlanPricing[$planId]['duration'];
            } else {
                $amount = 49.00;
                $durationDays = 30;
            }
        }

        // Check if subscription already exists for this payment_id or order_id
        $stmtExistingSub = $pdo->prepare('SELECT * FROM user_subscriptions WHERE payment_id = ? OR order_id = ? FOR UPDATE');
        $stmtExistingSub->execute([$paymentId, $orderId]);
        $existingSubRow = $stmtExistingSub->fetch();

        if ($existingSubRow) {
            $subscriptionId = $existingSubRow['subscription_id'];
            $startsAt = $existingSubRow['starts_at'];
            $expiresAt = $existingSubRow['expires_at'];
            $subStatus = $existingSubRow['status'];
        } else {
            $subscriptionId = 'sub_' . round(microtime(true) * 1000) . '_' . substr(bin2hex(random_bytes(6)), 0, 8);
            $startsAt = date('Y-m-d H:i:s');
            $expiresAt = date('Y-m-d H:i:s', strtotime("+{$durationDays} days"));
            $subStatus = 'active';

            $stmtInsertSub = $pdo->prepare('
                INSERT INTO user_subscriptions (
                    subscription_id, user_id, plan_id, order_id, payment_id,
                    amount, currency, status, starts_at, expires_at, created_at, updated_at
                ) VALUES (
                    ?, ?, ?, ?, ?,
                    ?, "INR", "active", ?, ?, NOW(), NOW()
                )
            ');
            $stmtInsertSub->execute([
                $subscriptionId,
                $userId,
                $planId,
                $orderId,
                $paymentId,
                $amount,
                $startsAt,
                $expiresAt
            ]);
        }

        // Insert into payment_transactions
        $stmtTx = $pdo->prepare('
            INSERT INTO payment_transactions (
                order_id, payment_id, user_id, user_name, video_id, purpose, amount,
                tx_number, is_special, special_tag, referral_commission, admin_allocation, global_pool_allocation,
                created_at
            ) VALUES (
                ?, ?, ?, ?, NULL, "paid_subscription", ?,
                0, 0, "PAID_SUBSCRIPTION", 0.00, 0.00, 0.00,
                NOW()
            )
        ');
        $stmtTx->execute([
            $orderId, $paymentId, $userId, $userName, $amount
        ]);

        // STRICT FINANCIAL RULES:
        // Do NOT distribute subscription revenue through referral, wallet or existing income ledger rules.
        // Do NOT add Admin allocation or commission calculations.
        // Do NOT decide or implement subscription renewal/extension policy yet.

        // Update payment_orders status to "paid"
        try {
            $pdo->prepare('
                UPDATE payment_orders 
                SET status = "paid", payment_id = ?, updated_at = NOW() 
                WHERE order_id = ?
            ')->execute([$paymentId, $orderId]);
        } catch (Exception $ePoUpdate) {
            // Optional
        }

        $pdo->commit();

        jsonResponse([
            'verified' => true,
            'paymentId' => $paymentId,
            'orderId' => $orderId,
            'amount' => $amount,
            'purpose' => 'paid_subscription',
            'planId' => $planId,
            'txNumber' => 0,
            'isSpecialTransaction' => false,
            'specialTag' => 'PAID_SUBSCRIPTION',
            'subscription' => [
                'subscriptionId' => $subscriptionId,
                'userId' => $userId,
                'planId' => $planId,
                'orderId' => $orderId,
                'paymentId' => $paymentId,
                'amount' => $amount,
                'currency' => 'INR',
                'status' => $subStatus,
                'startsAt' => $startsAt,
                'expiresAt' => $expiresAt,
                'durationDays' => $durationDays,
            ],
        ]);
        exit;
    } else {
        // -------------------------------------------------------------------------
        // ADS PROMOTION (Task 33: 7-Level Referral Commission Distribution)
        // Dynamically loads Admin-controlled marketing percentage from platform_settings
        // Base schedule: L1=15% (or Admin marketing_income_percentage), L2=10%, L3=5%, L4=4%, L5=3%, L6=2%, L7=1%
        // Base Admin Share: 60% (or mathematical remainder). Missing levels redirected to Admin.
        // Sequence counter for Premium Videos is NOT incremented.
        // -------------------------------------------------------------------------
        $txNumber = 0;
        $isSpecial = false;
        $specialTag = 'ADS_PROMOTION';
        $globalPoolAllocation = 0.00;

        // Resolve up to 7 valid upline sponsors with strict cycle and self-referral prevention
        $visited = [strtoupper($userId) => true];
        $uplines = [];
        $currentUplineId = $userId;

        for ($lvl = 1; $lvl <= 7; $lvl++) {
            $stmtUpUser = $pdo->prepare('SELECT user_id, referral_code, name FROM users WHERE UPPER(user_id) = UPPER(?) LIMIT 1');
            $stmtUpUser->execute([$currentUplineId]);
            $currUserRow = $stmtUpUser->fetch();
            if (!$currUserRow) break;

            $uRefCode = trim($currUserRow['referral_code'] ?? '');
            if (empty($uRefCode)) break;

            $stmtUpMatch = $pdo->prepare('
                SELECT user_id, referral_code, name FROM users 
                WHERE (UPPER(user_id) = UPPER(?) OR UPPER(referral_code) = UPPER(?)) 
                  AND UPPER(user_id) != UPPER(?) 
                LIMIT 1
            ');
            $stmtUpMatch->execute([$uRefCode, $uRefCode, $currentUplineId]);
            $matchedSponsor = $stmtUpMatch->fetch();
            if (!$matchedSponsor) break;

            $sNormId = strtoupper($matchedSponsor['user_id']);
            if (isset($visited[$sNormId])) {
                // Terminate traversal on loop or already visited sponsor
                break;
            }

            $visited[$sNormId] = true;
            $uplines[$lvl] = [
                'level' => $lvl,
                'userId' => $matchedSponsor['user_id'],
                'name' => $matchedSponsor['name'] ?? 'Creator'
            ];
            $currentUplineId = $matchedSponsor['user_id'];
        }

        // Direct Level 1 referrer ID for backward-compatible response
        $verifiedReferrerId = isset($uplines[1]) ? $uplines[1]['userId'] : null;

        // Resolve Admin user identifier from database
        $stmtAdmin = $pdo->query("SELECT user_id FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1");
        $adminRow = $stmtAdmin->fetch();
        $adminUserId = $adminRow['user_id'] ?? 'FT102857';

        // 7-Level Rate Percentages (Defaults)
        $rates = [1 => 15, 2 => 10, 3 => 5, 4 => 4, 5 => 3, 6 => 2, 7 => 1];
        $marketingPercentage = null;

        // Query Hostinger MySQL platform_settings table if present
        try {
            $stmtSettings = $pdo->query("SELECT setting_key, setting_value FROM platform_settings");
            if ($stmtSettings) {
                $settingRows = $stmtSettings->fetchAll(PDO::FETCH_ASSOC);
                foreach ($settingRows as $sRow) {
                    $sKey = $sRow['setting_key'] ?? '';
                    $sVal = $sRow['setting_value'] ?? '';
                    if ($sKey === 'marketing_income_percentage' && is_numeric($sVal)) {
                        $parsedMkt = floatval($sVal);
                        if ($parsedMkt >= 0 && $parsedMkt <= 100) {
                            $marketingPercentage = $parsedMkt;
                        }
                    } elseif (preg_match('/^ads_referral_rate_l([1-7])$/', $sKey, $m) && is_numeric($sVal)) {
                        $lvl = intval($m[1]);
                        $parsedRate = floatval($sVal);
                        if ($parsedRate >= 0 && $parsedRate <= 100) {
                            $rates[$lvl] = $parsedRate;
                        }
                    }
                }
            }
        } catch (Exception $eSettings) {
            // platform_settings table not yet created or inaccessible; safely fall back to default schedule
        }

        // If marketing_income_percentage was set by Admin, it governs Level 1 (Direct Referrer / Sponsor)
        if ($marketingPercentage !== null) {
            $rates[1] = $marketingPercentage;
        }

        // Safe mathematical check: total upline commission percentage cannot exceed 100%
        $totalCommissionSchedule = array_sum($rates);
        if ($totalCommissionSchedule > 100.0) {
            error_log("[verify.php] Warning: Configured commission rates total {$totalCommissionSchedule}%, which exceeds 100%. Reverting Level 1 to safe default 15%.");
            $rates[1] = 15;
        }

        $totalPaise = (int)round($amount * 100);
        $allocatedPaise = 0;
        $levelPayouts = [];
        $missingLevels = [];

        foreach ($rates as $lvl => $pct) {
            if (isset($uplines[$lvl])) {
                $commPaise = (int)round($totalPaise * ($pct / 100));
                $allocatedPaise += $commPaise;
                $levelPayouts[] = [
                    'level' => $lvl,
                    'percent' => $pct,
                    'userId' => $uplines[$lvl]['userId'],
                    'name' => $uplines[$lvl]['name'],
                    'amount' => $commPaise / 100,
                    'amountPaise' => $commPaise,
                ];
            } else {
                $missingLevels[] = $lvl;
            }
        }

        // Exact integer remainder formula guarantees sum of all credits equals plan amount with zero rounding loss
        $adminPaise = max(0, $totalPaise - $allocatedPaise);
        $adminAmount = $adminPaise / 100;
        $totalReferralAmount = $allocatedPaise / 100;
        $adminAllocation = $adminAmount;
        $referralCommission = $totalReferralAmount;
        $adminPercent = (int)round(($adminPaise / $totalPaise) * 100);

        // Record payment in payment_transactions
        $stmtTx = $pdo->prepare('
            INSERT INTO payment_transactions (
                order_id, payment_id, user_id, user_name, video_id, purpose, amount,
                tx_number, is_special, special_tag, referral_commission, admin_allocation, global_pool_allocation,
                created_at
            ) VALUES (
                ?, ?, ?, ?, ?, ?, ?,
                0, 0, "ADS_PROMOTION", ?, ?, 0.00,
                NOW()
            )
        ');
        $stmtTx->execute([
            $orderId, $paymentId, $userId, $userName, $videoId ?: null, $purpose, $amount,
            $totalReferralAmount, $adminAmount
        ]);

        // Detect whether expanded ENUM ('ad_boost_income', 'marketing_income') is supported by income_ledger.income_type
        $uplineIncomeType = 'referral_income';
        try {
            $colStmt = $pdo->query("SHOW COLUMNS FROM income_ledger LIKE 'income_type'");
            if ($colStmt) {
                $colRow = $colStmt->fetch(PDO::FETCH_ASSOC);
                $typeStr = $colRow['Type'] ?? '';
                if (strpos($typeStr, 'ad_boost_income') !== false) {
                    $uplineIncomeType = 'ad_boost_income';
                } elseif (strpos($typeStr, 'marketing_income') !== false) {
                    $uplineIncomeType = 'marketing_income';
                }
            }
        } catch (Exception $eCol) {
            // Table inspection fallback
        }

        // Insert atomic ledger entries and credit wallet balances for each valid upline sponsor
        $stmtLedger = $pdo->prepare('
            INSERT INTO income_ledger (
                id, transaction_id, user_id, source_user_id, source_user_name, video_id,
                income_type, amount, status, special_tag, description, created_at
            ) VALUES (
                ?, ?, ?, ?, ?, ?,
                ?, ?, "settled", ?, ?, NOW()
            )
        ');
        $stmtCredit = $pdo->prepare('
            INSERT INTO wallet_balances (user_id, balance, total_earned, total_withdrawn, referral_income, global_income, adsense_income, affiliate_income, updated_at)
            VALUES (?, ?, ?, 0.00, ?, 0.00, 0.00, 0.00, NOW())
            ON DUPLICATE KEY UPDATE
                balance = balance + VALUES(balance),
                total_earned = total_earned + VALUES(total_earned),
                referral_income = referral_income + VALUES(referral_income),
                updated_at = NOW()
        ');

        foreach ($levelPayouts as $payout) {
            $lId = $payout['level'];
            $txId = "TX_ADS_L{$lId}_{$paymentId}";
            $lUuid = sprintf('%04x%04x-%04x-%04x-%04x-%04x%04x%04x',
                mt_rand(0, 0xffff), mt_rand(0, 0xffff), mt_rand(0, 0xffff),
                mt_rand(0, 0x0fff) | 0x4000, mt_rand(0, 0x3fff) | 0x8000,
                mt_rand(0, 0xffff), mt_rand(0, 0xffff), mt_rand(0, 0xffff));
            $desc = "Level {$lId} commission ({$payout['percent']}%) for Ads Promotion by {$userName} ({$userId})";

            $stmtLedger->execute([
                $lUuid,
                $txId,
                $payout['userId'],
                $userId,
                $userName,
                $videoId ?: null,
                $uplineIncomeType,
                $payout['amount'],
                "ADS_REF_L{$lId}",
                $desc
            ]);

            $stmtCredit->execute([
                $payout['userId'],
                $payout['amount'],
                $payout['amount'],
                $payout['amount']
            ]);
        }

        // Record Admin allocation (base share + missing level remainder) in income_ledger and wallet_balances
        if ($adminAmount > 0) {
            $txAdminId = "TX_ADS_ADM_{$paymentId}";
            $admUuid = sprintf('%04x%04x-%04x-%04x-%04x-%04x%04x%04x',
                mt_rand(0, 0xffff), mt_rand(0, 0xffff), mt_rand(0, 0xffff),
                mt_rand(0, 0x0fff) | 0x4000, mt_rand(0, 0x3fff) | 0x8000,
                mt_rand(0, 0xffff), mt_rand(0, 0xffff), mt_rand(0, 0xffff));
            $admDesc = "Admin allocation ({$adminPercent}%) including base share and unallocated referral shares for Ads Promotion by {$userName} ({$userId})";

            $stmtLedger->execute([
                $admUuid,
                $txAdminId,
                $adminUserId,
                $userId,
                $userName,
                $videoId ?: null,
                "admin_allocation",
                $adminAmount,
                "ADS_ADMIN_SHARE",
                $admDesc
            ]);

            $stmtCreditAdmin = $pdo->prepare('
                INSERT INTO wallet_balances (user_id, balance, total_earned, total_withdrawn, referral_income, global_income, adsense_income, affiliate_income, updated_at)
                VALUES (?, ?, ?, 0.00, 0.00, 0.00, 0.00, 0.00, NOW())
                ON DUPLICATE KEY UPDATE
                    balance = balance + VALUES(balance),
                    total_earned = total_earned + VALUES(total_earned),
                    updated_at = NOW()
            ');
            $stmtCreditAdmin->execute([
                $adminUserId,
                $adminAmount,
                $adminAmount
            ]);
        }
    }

    // 3.7 Feature Activation: Premium Video or Ad Promotion
    $promotionAppliedNow = false;
    if (!empty($videoId)) {
        if ($purpose === 'ads_promotion') {
            $alreadyAppliedOrder = $hasPromoAppliedAtCol && !empty($orderRecord['promotion_applied_at']);
            $alreadyAppliedVideo = $hasPromoPaymentIdCol && $lockedVideoRow && ((string)($lockedVideoRow['promotion_payment_id'] ?? '') === $paymentId);

            if (!$alreadyAppliedOrder && !$alreadyAppliedVideo) {
                // Plan durations strictly derived server-side from verified planId
                $planDurations = [
                    'plan-7-days' => 7,
                    'plan-15-days' => 15,
                    'plan-monthly' => 30,
                    'plan-yearly' => 365,
                ];
                $durationDays = $planDurations[$planId] ?? 30;

                // Business Rule: Add duration to active expiry date, otherwise start from NOW()
                $promoPaymentSetSql = $hasPromoPaymentIdCol ? ', promotion_payment_id = :paymentId' : '';
                $stmtPromo = $pdo->prepare("
                    UPDATE uploaded_videos 
                    SET is_promoted = 1,
                        promotion_plan = :planId,
                        promotion_expires_at = IF(
                            promotion_expires_at IS NOT NULL AND promotion_expires_at > NOW(),
                            DATE_ADD(promotion_expires_at, INTERVAL :durationDays DAY),
                            DATE_ADD(NOW(), INTERVAL :durationDays DAY)
                        ){$promoPaymentSetSql},
                        updated_at = NOW()
                    WHERE id = :videoId
                ");
                $promoParams = [
                    ':planId' => $planId,
                    ':durationDays' => $durationDays,
                    ':videoId' => $videoId,
                ];
                if ($hasPromoPaymentIdCol) {
                    $promoParams[':paymentId'] = $paymentId;
                }
                $stmtPromo->execute($promoParams);
                $promotionAppliedNow = true;
            }
        } elseif ($isPremiumUpload) {
            $pdo->prepare('
                UPDATE uploaded_videos 
                SET payment_status = "paid", payment_id = ?, payment_amount = ?, updated_at = NOW()
                WHERE id = ?
            ')->execute([$paymentId, $amount, $videoId]);
        }
    }

    // 3.8 Update payment_orders status to 'paid' (and promotion_applied_at when ads_promotion was activated)
    try {
        if ($purpose === 'ads_promotion' && $hasPromoAppliedAtCol && $promotionAppliedNow) {
            $pdo->prepare('
                UPDATE payment_orders 
                SET status = "paid", payment_id = ?, promotion_applied_at = NOW(), updated_at = NOW() 
                WHERE order_id = ?
            ')->execute([$paymentId, $orderId]);
        } else {
            $pdo->prepare('
                UPDATE payment_orders 
                SET status = "paid", payment_id = ?, updated_at = NOW() 
                WHERE order_id = ?
            ')->execute([$paymentId, $orderId]);
        }
    } catch (Exception $ePoUpdate) {
        // Optional
    }

    // Commit all operations atomically
    $pdo->commit();

    jsonResponse([
        'verified' => true,
        'paymentId' => $paymentId,
        'orderId' => $orderId,
        'amount' => $amount,
        'purpose' => $purpose,
        'txNumber' => $txNumber,
        'isSpecialTransaction' => $isSpecial,
        'specialTag' => $specialTag,
        'distribution' => array_merge([
            'directReferralAmount' => $verifiedReferrerId && !empty($levelPayouts[0]) ? $levelPayouts[0]['amount'] : $referralCommission,
            'referrerId' => $verifiedReferrerId,
            'referralStatus' => $referralStatus,
            'adminAmount' => $adminAllocation,
            'adminPercent' => $adminPercent,
            'globalPoolAmount' => $globalPoolAllocation,
            'gstAmount' => $gstAmount,
            'pgFeeAmount' => $pgFeeAmount,
            'taxAndFees' => $taxAndFees,
            'totalAmount' => $amount,
            'eligibleMembersCount' => $isPremiumUpload ? $eligibleCreatorCount : 0,
            'perMemberShare' => $isPremiumUpload && $eligibleCreatorCount > 0 && !empty($creatorPayouts[0]) ? $creatorPayouts[0]['amount'] : 0.0,
            'creatorPayouts' => $creatorPayouts,
            'totalReferralAmount' => $totalReferralAmount,
            'levelPayouts' => $levelPayouts,
            'missingLevels' => $missingLevels,
        ], $isPremiumUpload ? [
            'globalPoolDistributedAmount' => $globalPoolDistributed,
            'globalPoolReserveAmount' => $globalPoolReserve,
            'globalPoolStatus' => $globalPoolStatus,
            'globalPoolReserveReason' => $globalPoolReserveReason,
            'globalPoolReserveId' => $globalPoolReserveId,
        ] : [])
    ]);
} catch (Throwable $e) {
    $safeRollback($pdo);

    $isConnUnavailable = $isConnectionUnavailable($e);

    // Check for duplicate key conflict (error code 23000 / 1062)
    if (
        !$isConnUnavailable &&
        ((string)$e->getCode() === '23000' || str_contains($e->getMessage(), '1062') || str_contains($e->getMessage(), 'Duplicate entry'))
    ) {
        try {
            $stmtExisting = $pdo->prepare('SELECT * FROM payment_transactions WHERE payment_id = ? LIMIT 1');
            $stmtExisting->execute([$paymentId]);
            $existingTx = $stmtExisting->fetch();
            if ($existingTx) {
                $existingSub = null;
                if ($existingTx['purpose'] === 'paid_subscription') {
                    try {
                        $stmtSub = $pdo->prepare('SELECT * FROM user_subscriptions WHERE payment_id = ? OR order_id = ? LIMIT 1');
                        $stmtSub->execute([$paymentId, $orderId]);
                        $subRow = $stmtSub->fetch();
                        if ($subRow) {
                            $existingSub = [
                                'subscriptionId' => $subRow['subscription_id'],
                                'userId' => $subRow['user_id'],
                                'planId' => $subRow['plan_id'],
                                'orderId' => $subRow['order_id'],
                                'paymentId' => $subRow['payment_id'],
                                'amount' => floatval($subRow['amount']),
                                'currency' => $subRow['currency'],
                                'status' => $subRow['status'],
                                'startsAt' => $subRow['starts_at'],
                                'expiresAt' => $subRow['expires_at'],
                            ];
                        }
                    } catch (Exception $eSub) {
                        // ignore
                    }
                }
                $duplicateResp = [
                    'verified' => true,
                    'paymentId' => $existingTx['payment_id'],
                    'orderId' => $existingTx['order_id'],
                    'amount' => floatval($existingTx['amount']),
                    'purpose' => $existingTx['purpose'],
                    'txNumber' => intval($existingTx['tx_number']),
                    'isSpecialTransaction' => (bool)$existingTx['is_special'],
                    'specialTag' => $existingTx['special_tag'],
                    'duplicate' => true,
                    'message' => 'Concurrent duplicate detected and resolved safely without double crediting.'
                ];
                if ($existingTx['purpose'] === 'premium_video_upload') {
                    $dupGst = isset($existingTx['gst_amount']) && floatval($existingTx['gst_amount']) > 0 ? floatval($existingTx['gst_amount']) : 0.90;
                    $dupPg = isset($existingTx['pg_fee']) && floatval($existingTx['pg_fee']) > 0 ? floatval($existingTx['pg_fee']) : 0.10;
                    $dupRefStatus = !empty($existingTx['referral_status']) && $existingTx['referral_status'] !== 'not_applicable'
                        ? (string)$existingTx['referral_status']
                        : (floatval($existingTx['referral_commission'] ?? 0) > 0 ? 'credited' : 'unassigned_pending');
                    $dupPoolAllocated = floatval($existingTx['global_pool_allocation']);
                    $dupPoolDistributed = isset($existingTx['global_pool_distributed'])
                        ? floatval($existingTx['global_pool_distributed'])
                        : $dupPoolAllocated;
                    $dupPoolReserve = isset($existingTx['global_pool_reserve'])
                        ? floatval($existingTx['global_pool_reserve'])
                        : max(0.0, round($dupPoolAllocated - $dupPoolDistributed, 2));
                    $dupPoolStatus = !empty($existingTx['global_pool_status']) && $existingTx['global_pool_status'] !== 'not_applicable'
                        ? (string)$existingTx['global_pool_status']
                        : ($dupPoolReserve <= 0 ? 'settled' : ($dupPoolDistributed <= 0 ? 'pending_reserve' : 'partial_reserve'));
                    $duplicateResp['distribution'] = [
                        'directReferralAmount' => floatval($existingTx['referral_commission']),
                        'referralStatus' => $dupRefStatus,
                        'adminAmount' => floatval($existingTx['admin_allocation']),
                        'globalPoolAmount' => $dupPoolAllocated,
                        'globalPoolDistributedAmount' => $dupPoolDistributed,
                        'globalPoolReserveAmount' => $dupPoolReserve,
                        'globalPoolStatus' => $dupPoolStatus,
                        'gstAmount' => $dupGst,
                        'pgFeeAmount' => $dupPg,
                        'taxAndFees' => round($dupGst + $dupPg, 2),
                        'totalAmount' => floatval($existingTx['amount']),
                    ];
                }
                if ($existingSub) {
                    $duplicateResp['subscription'] = $existingSub;
                }
                jsonResponse($duplicateResp);
                exit;
            }
        } catch (Throwable $_dupLookupErr) {
            error_log('[verify.php] Duplicate lookup fallback failed: ' . $_dupLookupErr->getMessage());
        }
    }

    // Safe error message without exposing database tables or SQL traces
    error_log('[verify.php] Database Exception: ' . $e->getMessage());
    if ($isConnUnavailable) {
        jsonResponse([
            'verified' => false,
            'paymentId' => $paymentId,
            'orderId' => $orderId,
            'error' => 'Database connection unavailable during payment verification. Transaction was safely rolled back.'
        ], 503);
    }
    jsonResponse([
        'verified' => false,
        'paymentId' => $paymentId,
        'orderId' => $orderId,
        'error' => 'Payment processing failed during database recording. Transaction was safely rolled back.'
    ], 500);
}
