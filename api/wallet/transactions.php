<?php
/**
 * FaceTube - Wallet Transactions API
 * GET /api/wallet/transactions.php
 */

require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/../response.php';

$pdo = getDatabaseConnection();
$requestedUserId = trim($_GET['userId'] ?? ($_GET['user_id'] ?? ''));

// Strictly derive identity from session token and restrict cross-user access to admins
list($authUser, $userId) = requireAuthUser($pdo, $requestedUserId ?: null);

try {
    $whereLedger = 'WHERE UPPER(user_id) = UPPER(?)';
    $params = [$userId];

    $rawAll = strtolower(trim((string)($_GET['all'] ?? '')));
    $rawLimit = strtolower(trim((string)($_GET['limit'] ?? '')));
    $fetchAll = ($rawAll === '1' || $rawAll === 'true' || $rawLimit === 'all');
    $page = max(1, intval($_GET['page'] ?? 1));
    $limit = $fetchAll ? 5000 : max(1, min(500, intval($_GET['limit'] ?? 50)));
    $offset = $fetchAll ? 0 : (($page - 1) * $limit);

    $limitSql = $fetchAll ? '' : (" LIMIT " . intval($limit) . " OFFSET " . intval($offset));

    $transactions = [];
    $usedSource = 'income_ledger';
    try {
        $stmt = $pdo->prepare("
            SELECT id, transaction_id, user_id, source_user_id, source_user_name, video_id, 
                   income_type, amount, status, special_tag, description,
                   batch_id, payout_method, beneficiary_details, created_at
            FROM income_ledger 
            {$whereLedger} 
            ORDER BY created_at DESC{$limitSql}
        ");
        $stmt->execute($params);
        $transactions = $stmt->fetchAll();
    } catch (PDOException $eLedger) {
        // Fallback to legacy income_ledger columns if new columns not yet migrated
        try {
            $stmt = $pdo->prepare("
                SELECT id, transaction_id, user_id, source_user_id, source_user_name, video_id, 
                       income_type, amount, status, special_tag, description, created_at
                FROM income_ledger 
                {$whereLedger} 
                ORDER BY created_at DESC{$limitSql}
            ");
            $stmt->execute($params);
            $transactions = $stmt->fetchAll();
        } catch (PDOException $eLedgerLegacy) {
            // Fallback to wallet_transactions if income_ledger is not present
            $usedSource = 'wallet_transactions';
            try {
                $stmt2 = $pdo->prepare("SELECT * FROM wallet_transactions {$whereLedger} ORDER BY created_at DESC{$limitSql}");
                $stmt2->execute($params);
                $transactions = $stmt2->fetchAll();
            } catch (PDOException $e2) {
                $transactions = [];
            }
        }
    }

    $mapped = array_map(function ($tx) {
        return [
            'id' => $tx['id'] ?? ('tx_' . uniqid()),
            'transactionId' => $tx['transaction_id'] ?? ($tx['id'] ?? ''),
            'transaction_id' => $tx['transaction_id'] ?? ($tx['id'] ?? ''),
            'userId' => $tx['user_id'] ?? '',
            'user_id' => $tx['user_id'] ?? '',
            'sourceUserId' => $tx['source_user_id'] ?? null,
            'source_user_id' => $tx['source_user_id'] ?? null,
            'sourceUserName' => $tx['source_user_name'] ?? null,
            'source_user_name' => $tx['source_user_name'] ?? null,
            'videoId' => $tx['video_id'] ?? null,
            'incomeType' => $tx['income_type'] ?? ($tx['type'] ?? 'referral_income'),
            'income_type' => $tx['income_type'] ?? ($tx['type'] ?? 'referral_income'),
            'amount' => floatval($tx['amount'] ?? 0),
            'status' => $tx['status'] ?? 'settled',
            'specialTag' => $tx['special_tag'] ?? null,
            'special_tag' => $tx['special_tag'] ?? null,
            'description' => $tx['description'] ?? 'Transaction',
            'batchId' => $tx['batch_id'] ?? null,
            'batch_id' => $tx['batch_id'] ?? null,
            'payoutMethod' => $tx['payout_method'] ?? null,
            'payout_method' => $tx['payout_method'] ?? null,
            'beneficiaryDetails' => $tx['beneficiary_details'] ?? null,
            'beneficiary_details' => $tx['beneficiary_details'] ?? null,
            'createdAt' => $tx['created_at'] ?? date('c'),
            'created_at' => $tx['created_at'] ?? date('c'),
        ];
    }, $transactions);

    $summarizeTransactionRows = static function (array $txList): array {
        $directReferralIncome = 0.0;
        $adBoostIncome = 0.0;
        $pendingReferralIncome = 0.0;
        $globalIncome = 0.0;
        $adsenseIncome = 0.0;
        $admobIncome = 0.0;
        $affiliateIncome = 0.0;
        $totalEarned = 0.0;
        $totalWithdrawn = 0.0;

        foreach ($txList as $tx) {
            $amt = floatval($tx['amount'] ?? 0);
            $st = strtolower(trim((string)($tx['status'] ?? 'settled')));
            $tType = strtolower(trim((string)($tx['income_type'] ?? ($tx['incomeType'] ?? ($tx['type'] ?? '')))));
            $txIdUpper = strtoupper(trim((string)($tx['transaction_id'] ?? ($tx['transactionId'] ?? ($tx['id'] ?? '')))));
            $tagUpper = strtoupper(trim((string)($tx['special_tag'] ?? ($tx['specialTag'] ?? ''))));

            $isAds = ($tType === 'ad_boost_income'
                || $tType === 'marketing_ads'
                || str_starts_with($txIdUpper, 'TX_ADS_L')
                || str_starts_with($tagUpper, 'ADS_REF_L'));
            $isDirect = (!$isAds
                && ($tType === 'referral_income' || $tType === 'direct_commission')
                && !str_starts_with($txIdUpper, 'TX_REF_PENDING_'));

            if ($st === 'pending') {
                if ($isAds || $tType === 'referral_income' || $tType === 'direct_commission') {
                    $pendingReferralIncome += $amt;
                }
                continue;
            }
            $isSettledStatus = ($st === '' || $st === 'settled' || $st === 'completed' || ($tType === 'withdrawal' && $st === 'approved'));
            if (!$isSettledStatus) {
                continue;
            }

            if ($tType === 'withdrawal') {
                $totalWithdrawn += abs($amt);
            } else {
                if ($tType !== 'ads_promotion_fee') {
                    $totalEarned += $amt;
                }
                if ($isAds) {
                    $adBoostIncome += $amt;
                } elseif ($isDirect) {
                    $directReferralIncome += $amt;
                } elseif ($tType === 'global_income') {
                    $globalIncome += $amt;
                } elseif ($tType === 'adsense_income') {
                    $adsenseIncome += $amt;
                } elseif ($tType === 'admob_income') {
                    $admobIncome += $amt;
                } elseif ($tType === 'affiliate_income' || $tType === 'marketing_income') {
                    $affiliateIncome += $amt;
                }
            }
        }

        return [
            'totalCount' => count($txList),
            'directReferralIncome' => round($directReferralIncome, 2),
            'adBoostIncome' => round($adBoostIncome, 2),
            'pendingReferralIncome' => round($pendingReferralIncome, 2),
            'globalIncome' => round($globalIncome, 2),
            'adsenseIncome' => round($adsenseIncome, 2),
            'admobIncome' => round($admobIncome, 2),
            'affiliateIncome' => round($affiliateIncome, 2),
            'totalEarned' => round($totalEarned, 2),
            'totalWithdrawn' => round($totalWithdrawn, 2),
        ];
    };

    $totalCount = count($mapped);
    $summary = $summarizeTransactionRows($transactions);
    $summaryComputed = false;

    if ($usedSource === 'income_ledger') {
        try {
            $stmtAgg = $pdo->prepare("
                SELECT
                    COUNT(*) AS total_count,
                    COALESCE(SUM(CASE
                        WHEN status = 'settled'
                         AND COALESCE(income_type, '') IN ('referral_income', 'direct_commission')
                         AND UPPER(COALESCE(transaction_id, '')) NOT LIKE 'TX|_REF|_PENDING|_%' ESCAPE '|'
                         AND UPPER(COALESCE(transaction_id, '')) NOT LIKE 'TX|_ADS|_L%' ESCAPE '|'
                         AND UPPER(COALESCE(special_tag, '')) NOT LIKE 'ADS|_REF|_L%' ESCAPE '|'
                        THEN amount ELSE 0 END), 0) AS direct_referral_income,
                    COALESCE(SUM(CASE
                        WHEN status = 'settled'
                         AND (
                             COALESCE(income_type, '') IN ('ad_boost_income', 'marketing_ads')
                             OR UPPER(COALESCE(transaction_id, '')) LIKE 'TX|_ADS|_L%' ESCAPE '|'
                             OR UPPER(COALESCE(special_tag, '')) LIKE 'ADS|_REF|_L%' ESCAPE '|'
                         )
                        THEN amount ELSE 0 END), 0) AS ad_boost_income,
                    COALESCE(SUM(CASE
                        WHEN status = 'pending'
                         AND (
                             COALESCE(income_type, '') IN ('referral_income', 'direct_commission', 'ad_boost_income', 'marketing_ads')
                             OR UPPER(COALESCE(transaction_id, '')) LIKE 'TX|_ADS|_L%' ESCAPE '|'
                             OR UPPER(COALESCE(special_tag, '')) LIKE 'ADS|_REF|_L%' ESCAPE '|'
                         )
                        THEN amount ELSE 0 END), 0) AS pending_referral_income,
                    COALESCE(SUM(CASE WHEN status = 'settled' AND COALESCE(income_type, '') = 'global_income' THEN amount ELSE 0 END), 0) AS global_income,
                    COALESCE(SUM(CASE WHEN status = 'settled' AND COALESCE(income_type, '') = 'adsense_income' THEN amount ELSE 0 END), 0) AS adsense_income,
                    COALESCE(SUM(CASE WHEN status = 'settled' AND COALESCE(income_type, '') = 'admob_income' THEN amount ELSE 0 END), 0) AS admob_income,
                    COALESCE(SUM(CASE
                        WHEN status = 'settled'
                         AND COALESCE(income_type, '') IN ('affiliate_income', 'marketing_income')
                         AND UPPER(COALESCE(transaction_id, '')) NOT LIKE 'TX|_ADS|_L%' ESCAPE '|'
                         AND UPPER(COALESCE(special_tag, '')) NOT LIKE 'ADS|_REF|_L%' ESCAPE '|'
                        THEN amount ELSE 0 END), 0) AS affiliate_income,
                    COALESCE(SUM(CASE WHEN status = 'settled' AND COALESCE(income_type, '') = 'withdrawal' THEN ABS(amount) ELSE 0 END), 0) AS total_withdrawn,
                    COALESCE(SUM(CASE WHEN status = 'settled' AND COALESCE(income_type, '') NOT IN ('withdrawal', 'ads_promotion_fee') THEN amount ELSE 0 END), 0) AS total_earned
                FROM income_ledger
                {$whereLedger}
            ");
            $stmtAgg->execute($params);
            $agg = $stmtAgg->fetch(PDO::FETCH_ASSOC);
            if ($agg) {
                $totalCount = max(intval($agg['total_count'] ?? 0), count($mapped));
                $summary = [
                    'totalCount' => $totalCount,
                    'directReferralIncome' => round(floatval($agg['direct_referral_income'] ?? 0), 2),
                    'adBoostIncome' => round(floatval($agg['ad_boost_income'] ?? 0), 2),
                    'pendingReferralIncome' => round(floatval($agg['pending_referral_income'] ?? 0), 2),
                    'globalIncome' => round(floatval($agg['global_income'] ?? 0), 2),
                    'adsenseIncome' => round(floatval($agg['adsense_income'] ?? 0), 2),
                    'admobIncome' => round(floatval($agg['admob_income'] ?? 0), 2),
                    'affiliateIncome' => round(floatval($agg['affiliate_income'] ?? 0), 2),
                    'totalEarned' => round(floatval($agg['total_earned'] ?? 0), 2),
                    'totalWithdrawn' => round(floatval($agg['total_withdrawn'] ?? 0), 2),
                ];
                $summaryComputed = true;
            }
        } catch (Exception $eAgg) {
            // Fall through to full-dataset row summarization below
        }

        if (!$summaryComputed && !$fetchAll) {
            try {
                $stmtAllLedger = $pdo->prepare("SELECT * FROM income_ledger {$whereLedger}");
                $stmtAllLedger->execute($params);
                $allLedgerRows = $stmtAllLedger->fetchAll(PDO::FETCH_ASSOC);
                if (is_array($allLedgerRows) && count($allLedgerRows) > 0) {
                    $totalCount = max(count($allLedgerRows), count($mapped));
                    $summary = $summarizeTransactionRows($allLedgerRows);
                    $summary['totalCount'] = $totalCount;
                }
            } catch (Exception $eAllLedger) {
                // Keep page-row summary initialized above
            }
        }
    } else {
        $wtSummaryComputed = $fetchAll;
        if (!$fetchAll) {
            try {
                $stmtAllWt = $pdo->prepare("SELECT * FROM wallet_transactions {$whereLedger}");
                $stmtAllWt->execute($params);
                $allWtRows = $stmtAllWt->fetchAll(PDO::FETCH_ASSOC);
                if (is_array($allWtRows) && count($allWtRows) > 0) {
                    $totalCount = max(count($allWtRows), count($mapped));
                    $summary = $summarizeTransactionRows($allWtRows);
                    $summary['totalCount'] = $totalCount;
                    $wtSummaryComputed = true;
                }
            } catch (Exception $eAllWt) {
                // Fall back to COUNT(*) + page rows below
            }
        }

        if (!$wtSummaryComputed) {
            try {
                $stmtCountW = $pdo->prepare("SELECT COUNT(*) AS total_count FROM wallet_transactions {$whereLedger}");
                $stmtCountW->execute($params);
                $cRow = $stmtCountW->fetch(PDO::FETCH_ASSOC);
                if ($cRow && isset($cRow['total_count'])) {
                    $totalCount = max(intval($cRow['total_count']), count($mapped));
                    $summary['totalCount'] = $totalCount;
                }
            } catch (Exception $eCW) {
                // ignore
            }
        }
    }

    $totalPages = $fetchAll ? 1 : ($totalCount > 0 ? (int)ceil($totalCount / $limit) : 1);
    $hasMore = !$fetchAll && ($offset + count($mapped) < $totalCount);

    jsonResponse([
        'success' => true,
        'transactions' => $mapped,
        'total' => $totalCount,
        'page' => $fetchAll ? 1 : $page,
        'limit' => $fetchAll ? max(count($mapped), 1) : $limit,
        'totalPages' => $totalPages,
        'hasMore' => $hasMore,
        'summary' => $summary,
    ]);
} catch (Exception $e) {
    jsonResponse(['success' => true, 'transactions' => [], 'total' => 0, 'page' => 1, 'limit' => 50, 'totalPages' => 1, 'hasMore' => false]);
}
