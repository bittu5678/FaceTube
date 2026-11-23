<?php
/**
 * FaceTube - Wallet Balance API
 * GET /api/wallet/balance.php
 */

require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/../response.php';

$pdo = getDatabaseConnection();
$requestedUserId = trim($_GET['userId'] ?? ($_GET['user_id'] ?? ''));

// Strictly derive identity from session token and restrict cross-user access to admins
list($authUser, $userId) = requireAuthUser($pdo, $requestedUserId ?: null);


try {
    $stmt = $pdo->prepare('SELECT * FROM wallet_balances WHERE UPPER(user_id) = UPPER(?) LIMIT 1');
    $stmt->execute([$userId]);
    $wallet = $stmt->fetch();

    if (!$wallet) {
        // Initialize an empty wallet record for the user if none exists yet
        try {
            $stmtInit = $pdo->prepare('
                INSERT INTO wallet_balances (user_id, balance, total_earned, total_withdrawn, referral_income, global_income, adsense_income, affiliate_income, updated_at)
                VALUES (?, 0.00, 0.00, 0.00, 0.00, 0.00, 0.00, 0.00, NOW())
                ON DUPLICATE KEY UPDATE updated_at = NOW()
            ');
            $stmtInit->execute([$userId]);
        } catch (Exception $eInit) {
            // Ignore insert race
        }

        $balance = 0.00;
        $totalEarned = 0.00;
        $totalWithdrawn = 0.00;
        $referralIncome = 0.00;
        $adBoostIncome = 0.00;
        $globalIncome = 0.00;
        $adsenseIncome = 0.00;
        $admobIncome = 0.00;
        $affiliateIncome = 0.00;
        $updatedAt = date('c');
    } else {
        $balance = floatval($wallet['balance'] ?? 0);
        $totalEarned = floatval($wallet['total_earned'] ?? $balance);
        $totalWithdrawn = floatval($wallet['total_withdrawn'] ?? 0);
        $referralIncome = floatval($wallet['referral_income'] ?? 0);
        $adBoostIncome = floatval($wallet['ad_boost_income'] ?? 0);
        $globalIncome = floatval($wallet['global_income'] ?? 0);
        $adsenseIncome = floatval($wallet['adsense_income'] ?? 0);
        $admobIncome = floatval($wallet['admob_income'] ?? 0);
        $affiliateIncome = floatval($wallet['affiliate_income'] ?? 0);
        $updatedAt = $wallet['updated_at'] ?? date('c');
    }

    // Separate Direct Referral income vs Ads Promotion / Ad Boost income from settled income_ledger
    // so both are reported cleanly without double-counting when wallet_balances.referral_income contains both.
    $directReferralIncome = $referralIncome;
    try {
        $stmtSep = $pdo->prepare("
            SELECT
                COUNT(*) AS ref_row_count,
                COALESCE(SUM(CASE
                    WHEN COALESCE(income_type, '') IN ('referral_income', 'direct_commission')
                     AND UPPER(COALESCE(transaction_id, '')) NOT LIKE 'TX|_REF|_PENDING|_%' ESCAPE '|'
                     AND UPPER(COALESCE(transaction_id, '')) NOT LIKE 'TX|_ADS|_L%' ESCAPE '|'
                     AND UPPER(COALESCE(special_tag, '')) NOT LIKE 'ADS|_REF|_L%' ESCAPE '|'
                    THEN amount ELSE 0 END), 0) AS ledger_direct_referral,
                COALESCE(SUM(CASE
                    WHEN COALESCE(income_type, '') IN ('ad_boost_income', 'marketing_ads')
                      OR UPPER(COALESCE(transaction_id, '')) LIKE 'TX|_ADS|_L%' ESCAPE '|'
                      OR UPPER(COALESCE(special_tag, '')) LIKE 'ADS|_REF|_L%' ESCAPE '|'
                    THEN amount ELSE 0 END), 0) AS ledger_ad_boost
            FROM income_ledger
            WHERE UPPER(user_id) = UPPER(?)
              AND status = 'settled'
              AND (
                  COALESCE(income_type, '') IN ('referral_income', 'direct_commission', 'ad_boost_income', 'marketing_ads')
                  OR UPPER(COALESCE(transaction_id, '')) LIKE 'TX|_ADS|_L%' ESCAPE '|'
                  OR UPPER(COALESCE(special_tag, '')) LIKE 'ADS|_REF|_L%' ESCAPE '|'
              )
        ");
        $stmtSep->execute([$userId]);
        $sepRow = $stmtSep->fetch(PDO::FETCH_ASSOC);
        if ($sepRow && intval($sepRow['ref_row_count'] ?? 0) > 0) {
            $directReferralIncome = round(floatval($sepRow['ledger_direct_referral'] ?? 0), 2);
            $adBoostIncome = round(floatval($sepRow['ledger_ad_boost'] ?? 0), 2);
            $referralIncome = $directReferralIncome;
        }
    } catch (Exception $eSep) {
        // Preserve wallet_balances fallback if income_ledger cannot be queried
    }

    jsonResponse([
        'success' => true,
        'wallet' => [
            'userId' => $userId,
            'user_id' => $userId,
            'balance' => $balance,
            'totalBalance' => $balance,
            'withdrawableBalance' => $balance,
            'referralIncome' => $directReferralIncome,
            'referral_income' => $directReferralIncome,
            'directReferralIncome' => $directReferralIncome,
            'direct_referral_income' => $directReferralIncome,
            'adBoostIncome' => $adBoostIncome,
            'ad_boost_income' => $adBoostIncome,
            'adsPromotionIncome' => $adBoostIncome,
            'globalIncome' => $globalIncome,
            'global_income' => $globalIncome,
            'adsenseIncome' => $adsenseIncome,
            'adsense_income' => $adsenseIncome,
            'admobIncome' => $admobIncome,
            'admob_income' => $admobIncome,
            'affiliateIncome' => $affiliateIncome,
            'affiliate_income' => $affiliateIncome,
            'totalEarnings' => $totalEarned,
            'total_earned' => $totalEarned,
            'totalWithdrawn' => $totalWithdrawn,
            'total_withdrawn' => $totalWithdrawn,
            'pendingWithdrawals' => 0.00,
            'updatedAt' => $updatedAt,
            'updated_at' => $updatedAt,
        ]
    ]);
} catch (PDOException $e) {
    jsonResponse(['success' => false, 'error' => 'Database error: ' . $e->getMessage()], 500);
}
