<?php
/**
 * FaceTube - Referral Dashboard API
 * GET /api/referrals/dashboard.php
 */

require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/../response.php';
require_once __DIR__ . '/downline.php';

$pdo = getDatabaseConnection();
$requestedUserId = trim($_GET['userId'] ?? ($_GET['user_id'] ?? ''));

// Strictly derive identity from session token and restrict cross-user access to admins
list($authUser, $userId) = requireAuthUser($pdo, $requestedUserId ?: null);


try {
    // 1. Get user profile
    $stmtUser = $pdo->prepare('SELECT id, user_id, name, referral_code, mobile FROM users WHERE UPPER(user_id) = UPPER(?) LIMIT 1');
    $stmtUser->execute([$userId]);
    $user = $stmtUser->fetch();

    if (!$user) {
        $emptyLevels = [];
        for ($i = 1; $i <= 10; $i++) {
            $emptyLevels[$i] = 0;
        }
        jsonResponse([
            'success' => true,
            'dashboard' => [
                'userId' => $userId,
                'referralCode' => $userId,
                'referralNumber' => '',
                'referralLink' => 'https://facetube.online/auth?ref=' . urlencode($userId),
                'directReferralsCount' => 0,
                'teamMembersCount' => 0,
                'referralIncome' => 0.00,
                'directReferralIncome' => 0.00,
                'adsPromotionIncome' => 0.00,
                'pendingReferralIncome' => 0.00,
                'totalReferralIncome' => 0.00,
                'members' => [],
                'referralMembers' => [],
                'levelCounts' => $emptyLevels,
            ]
        ]);
        exit;
    }

    $userNormId = $user['user_id'];
    $knownAliases = getKnownPromotionalAliases();
    $shareCode = (isset($knownAliases[strtoupper($userNormId)]) && !empty($knownAliases[strtoupper($userNormId)][0]))
        ? $knownAliases[strtoupper($userNormId)][0]
        : $userNormId;

    // 2. Real cycle-safe multi-level downline calculation across Levels 1–10
    // Uses user_id and verified promotional aliases to match genuine direct referrals
    $downline = calculateDownlineLevels($pdo, $userNormId, 10);
    $directCount = $downline['directCount'];
    $totalTeamCount = $downline['totalTeamCount'];

    // Direct referrals list for member breakdown
    $directReferrals = $downline['membersByLevel'][1] ?? [];

    // 3. Authoritative Direct Premium Upload & Referral commission from settled income_ledger
    // Preserves valid settled ledger entries even when a matching payment_transactions row does not exist;
    // excludes pending, non-premium matched payments, and Ads Promotion commissions.
    $directCommByMember = [];
    $directReferralIncome = 0.00;
    $stmtDirectLedger = $pdo->prepare("
        SELECT COALESCE(NULLIF(UPPER(TRIM(il.source_user_id)), ''), NULLIF(UPPER(TRIM(pt.user_id)), ''), '') AS member_user_id,
               COALESCE(SUM(il.amount), 0) AS direct_commission
        FROM income_ledger il
        LEFT JOIN payment_transactions pt
          ON UPPER(COALESCE(il.transaction_id, '')) LIKE 'TX|_REF|_%' ESCAPE '|'
         AND UPPER(COALESCE(il.transaction_id, '')) NOT LIKE 'TX|_REF|_PENDING|_%' ESCAPE '|'
         AND pt.payment_id = SUBSTRING(il.transaction_id, 8)
        WHERE UPPER(il.user_id) = UPPER(?)
          AND il.status = 'settled'
          AND il.amount > 0
          AND COALESCE(il.income_type, '') IN ('referral_income', 'direct_commission')
          AND UPPER(COALESCE(il.transaction_id, '')) NOT LIKE 'TX|_REF|_PENDING|_%' ESCAPE '|'
          AND UPPER(COALESCE(il.transaction_id, '')) NOT LIKE 'TX|_ADS|_L%' ESCAPE '|'
          AND UPPER(COALESCE(il.special_tag, '')) NOT LIKE 'ADS|_REF|_L%' ESCAPE '|'
          AND (
              pt.payment_id IS NULL
              OR (
                  pt.purpose = 'premium_video_upload'
                  AND pt.amount > 0
                  AND (
                      COALESCE(NULLIF(TRIM(il.source_user_id), ''), '') = ''
                      OR UPPER(TRIM(il.source_user_id)) = UPPER(TRIM(pt.user_id))
                  )
              )
          )
        GROUP BY COALESCE(NULLIF(UPPER(TRIM(il.source_user_id)), ''), NULLIF(UPPER(TRIM(pt.user_id)), ''), '')
    ");
    $stmtDirectLedger->execute([$userNormId]);
    $directRows = $stmtDirectLedger->fetchAll(PDO::FETCH_ASSOC);
    foreach ($directRows as $dr) {
        $mIdKey = strtoupper(trim((string)($dr['member_user_id'] ?? '')));
        $amt = round(floatval($dr['direct_commission'] ?? 0), 2);
        if ($amt > 0) {
            if ($mIdKey !== '') {
                $directCommByMember[$mIdKey] = round(($directCommByMember[$mIdKey] ?? 0.0) + $amt, 2);
            }
            $directReferralIncome = round($directReferralIncome + $amt, 2);
        }
    }

    // 3b. Separately track Ads Promotion commissions (never mixed into directReferralIncome)
    $adsPromotionIncome = 0.00;
    $stmtAdsLedger = $pdo->prepare("
        SELECT COALESCE(SUM(amount), 0) AS ads_income
        FROM income_ledger
        WHERE UPPER(user_id) = UPPER(?)
          AND status = 'settled'
          AND (
              COALESCE(income_type, '') IN ('ad_boost_income', 'marketing_ads')
              OR UPPER(COALESCE(transaction_id, '')) LIKE 'TX|_ADS|_L%' ESCAPE '|'
              OR UPPER(COALESCE(special_tag, '')) LIKE 'ADS|_REF|_L%' ESCAPE '|'
          )
    ");
    $stmtAdsLedger->execute([$userNormId]);
    $adsRow = $stmtAdsLedger->fetch(PDO::FETCH_ASSOC);
    $adsPromotionIncome = round(floatval($adsRow['ads_income'] ?? 0), 2);

    // 3c. Track pending referral entries separately (never counted in settled totals)
    $pendingReferralIncome = 0.00;
    $stmtPendingLedger = $pdo->prepare("
        SELECT COALESCE(SUM(amount), 0) AS pending_income
        FROM income_ledger
        WHERE UPPER(user_id) = UPPER(?)
          AND status = 'pending'
          AND COALESCE(income_type, '') IN ('referral_income', 'direct_commission', 'ad_boost_income', 'marketing_ads')
    ");
    $stmtPendingLedger->execute([$userNormId]);
    $pendingRow = $stmtPendingLedger->fetch(PDO::FETCH_ASSOC);
    $pendingReferralIncome = round(floatval($pendingRow['pending_income'] ?? 0), 2);

    $totalReferralIncome = round($directReferralIncome + $adsPromotionIncome, 2);

    // 4. Calculate member video counts (display only — excluding not_required from paid premium count)
    $members = [];
    $stmtVideos = $pdo->prepare('
        SELECT video_type, payment_status, COUNT(*) as cnt
        FROM uploaded_videos
        WHERE UPPER(user_id) = UPPER(?)
        GROUP BY video_type, payment_status
    ');

    foreach ($directReferrals as $r) {
        $mUserId = $r['user_id'] ?? ($r['userId'] ?? '');
        if (empty($mUserId)) continue;
        $stmtVideos->execute([$mUserId]);
        $vRows = $stmtVideos->fetchAll();

        $freeCount = 0;
        $premiumPaidCount = 0;
        foreach ($vRows as $vr) {
            $vt = strtolower($vr['video_type'] ?? 'free');
            $ps = strtolower($vr['payment_status'] ?? '');
            $cnt = intval($vr['cnt'] ?? 0);
            if ($vt === 'free') {
                $freeCount += $cnt;
            } elseif ($vt === 'premium' && ($ps === 'paid' || $ps === 'completed')) {
                $premiumPaidCount += $cnt;
            }
        }

        // Direct Premium Upload commission derives strictly from authoritative ledger + verified payment records
        $memberComm = round(floatval($directCommByMember[strtoupper(trim((string)$mUserId))] ?? 0.00), 2);
        $channelName = !empty($r['channelName'])
            ? $r['channelName']
            : (!empty($r['channel_name']) ? $r['channel_name'] : ($r['name'] ?? 'FaceTube Creator'));
        $rawLogo = $r['channelLogoUrl'] ?? ($r['channel_logo_url'] ?? null);
        $channelLogoUrl = null;
        if (is_string($rawLogo)) {
            $trimmedLogo = trim($rawLogo);
            if ($trimmedLogo !== '' && strtolower($trimmedLogo) !== 'null' && strtolower($trimmedLogo) !== 'undefined') {
                $channelLogoUrl = $trimmedLogo;
            }
        }

        $members[] = [
            'id' => $r['id'] ?? ('mem_' . $mUserId),
            'userId' => $mUserId,
            'name' => $r['name'],
            'channelName' => $channelName,
            'channel_name' => $channelName,
            'channelLogoUrl' => $channelLogoUrl,
            'channel_logo_url' => $channelLogoUrl,
            'email' => $r['email'] ?? '',
            'mobile' => $r['mobile'] ?? '',
            'joinedAt' => $r['created_at'] ?? ($r['joinedAt'] ?? 'Recent'),
            'status' => 'Active',
            'tier' => (($r['role'] ?? 'user') === 'admin') ? 'Admin' : 'Creator',
            'freeVideosCount' => $freeCount,
            'premiumVideosCount' => $premiumPaidCount,
            'totalVideosCount' => $freeCount + $premiumPaidCount,
            'directCommissionEarned' => $memberComm,
            'contribution' => $memberComm,
            'access' => 'Granted',
        ];
    }

    jsonResponse([
        'success' => true,
        'dashboard' => [
            'userId' => $userNormId,
            'referralCode' => $shareCode,
            'referralNumber' => $user['mobile'] ?? '',
            'referralLink' => 'https://facetube.online/auth?ref=' . urlencode($shareCode),
            'directReferralsCount' => $directCount,
            'teamMembersCount' => $totalTeamCount,
            'referralIncome' => $directReferralIncome,
            'directReferralIncome' => $directReferralIncome,
            'adsPromotionIncome' => $adsPromotionIncome,
            'pendingReferralIncome' => $pendingReferralIncome,
            'totalReferralIncome' => $totalReferralIncome,
            'levelCounts' => $downline['levelCounts'],
            'members' => $members,
            'referralMembers' => $members,
        ]
    ]);
} catch (PDOException $e) {
    jsonResponse(['success' => false, 'error' => 'Database error: ' . $e->getMessage()], 500);
}
