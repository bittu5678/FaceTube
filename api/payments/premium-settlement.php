<?php
/**
 * FaceTube - Shared Sponsor (₹6 Premium Video) Settlement, Schema, & Asset Helpers
 *
 * Reused by /api/payments/recover-captured.php so Sponsor ₹6 distribution,
 * Global Pool pending reserve accounting, and uploaded_videos publication
 * maintain strict parity with /api/payments/verify.php and /api/videos/create.php.
 */

require_once __DIR__ . '/../response.php';
require_once __DIR__ . '/../country-utils.php';
require_once __DIR__ . '/../referrals/downline.php';

if (!function_exists('ftUuidV4Php')) {
    function ftUuidV4Php(): string {
        $data = random_bytes(16);
        $data[6] = chr((ord($data[6]) & 0x0f) | 0x40);
        $data[8] = chr((ord($data[8]) & 0x3f) | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }
}

if (!function_exists('ftIsConnectionUnavailablePhp')) {
    function ftIsConnectionUnavailablePhp(Throwable $e): bool {
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
}

if (!function_exists('ftIsMissingOptionalTablePhp')) {
    function ftIsMissingOptionalTablePhp(Throwable $e): bool {
        $sqlState = $e instanceof PDOException ? (string)$e->getCode() : '';
        $driverCode = ($e instanceof PDOException && isset($e->errorInfo[1])) ? (int)$e->errorInfo[1] : 0;
        return $sqlState === '42S02'
            || $driverCode === 1146
            || stripos($e->getMessage(), 'Base table or view not found') !== false
            || stripos($e->getMessage(), "doesn't exist") !== false;
    }
}

if (!function_exists('ftSafeRollbackPhp')) {
    function ftSafeRollbackPhp(PDO $conn): void {
        try {
            if ($conn->inTransaction()) {
                $conn->rollBack();
            }
        } catch (Throwable $_rollbackErr) {
            error_log('[premium-settlement.php][ROLLBACK] Rollback failed: ' . $_rollbackErr->getMessage());
        }
    }
}

if (!function_exists('ftCheckGlobalPoolReserveSchemaReadyPhp')) {
    /**
     * Verifies Global Pool reserve schema readiness (global_pool_reserves table).
     * Returns ['ready' => bool, 'status' => int, 'error' => ?string].
     */
    function ftCheckGlobalPoolReserveSchemaReadyPhp(PDO $pdo): array {
        try {
            $tblStmt = $pdo->query("
                SELECT TABLE_NAME
                FROM INFORMATION_SCHEMA.TABLES
                WHERE TABLE_SCHEMA = DATABASE()
                  AND TABLE_NAME = 'global_pool_reserves'
                LIMIT 1
            ");
            $rows = $tblStmt ? $tblStmt->fetchAll(PDO::FETCH_ASSOC) : [];
            if (!is_array($rows) || count($rows) === 0) {
                return [
                    'ready' => false,
                    'status' => 503,
                    'error' => 'Global Pool reserve schema migration has not been applied yet (missing global_pool_reserves table). Recovery safely aborted.',
                ];
            }
            return ['ready' => true, 'status' => 200, 'error' => null];
        } catch (Throwable $e) {
            error_log('[premium-settlement.php] Global Pool reserve schema readiness check failed: ' . $e->getMessage());
            return [
                'ready' => false,
                'status' => 503,
                'error' => ftIsConnectionUnavailablePhp($e)
                    ? 'Database connection unavailable while checking Global Pool reserve readiness. Recovery safely aborted.'
                    : 'Unable to verify Global Pool reserve schema readiness. Recovery safely aborted.',
            ];
        }
    }
}

if (!function_exists('ftInspectPremiumSchemaColumnsPhp')) {
    function ftInspectPremiumSchemaColumnsPhp(PDO $pdo, bool $hasGlobalPoolReservesTable = true): array {
        $schema = [
            'hasAdEarningsCol' => false,
            'hasIsBlockedCol' => false,
            'hasCountryCodeCol' => false,
            'hasPromoPaymentIdCol' => false,
            'hasPromoAppliedAtCol' => false,
            'hasPtGstCol' => false,
            'hasPtPgFeeCol' => false,
            'hasPtRefStatusCol' => false,
            'hasPtPoolDistCol' => false,
            'hasPtPoolResCol' => false,
            'hasPtPoolStatusCol' => false,
            'hasPremGstCol' => false,
            'hasPremPgFeeCol' => false,
            'hasPremRefStatusCol' => false,
            'hasPremPoolDistCol' => false,
            'hasPremPoolResCol' => false,
            'hasPremPoolStatusCol' => false,
            'hasGlobalPoolReservesTable' => $hasGlobalPoolReservesTable,
            'hasReserveReasonInsufficientEnum' => false,
            'hasPtAccountingCols' => false,
            'hasPtPoolBreakdownCols' => false,
            'hasPremAccountingCols' => false,
            'hasPremPoolBreakdownCols' => false,
        ];

        try {
            $colStmt = $pdo->query("
                SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE
                FROM INFORMATION_SCHEMA.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE()
                  AND (
                    (TABLE_NAME = 'uploaded_videos' AND COLUMN_NAME IN ('ad_earnings', 'is_blocked', 'country_code', 'promotion_payment_id'))
                    OR (TABLE_NAME = 'payment_orders' AND COLUMN_NAME = 'promotion_applied_at')
                    OR (TABLE_NAME = 'global_pool_reserves' AND COLUMN_NAME = 'reserve_reason')
                    OR (TABLE_NAME = 'payment_transactions' AND COLUMN_NAME IN ('gst_amount', 'pg_fee', 'referral_status', 'global_pool_distributed', 'global_pool_reserve', 'global_pool_status'))
                    OR (TABLE_NAME = 'premium_transactions' AND COLUMN_NAME IN ('gst_amount', 'pg_fee', 'referral_status', 'global_pool_distributed', 'global_pool_reserve', 'global_pool_status'))
                  )
            ");
            if ($colStmt) {
                foreach ($colStmt->fetchAll(PDO::FETCH_ASSOC) as $colRow) {
                    $tbl = strtolower((string)($colRow['TABLE_NAME'] ?? ''));
                    $col = strtolower((string)($colRow['COLUMN_NAME'] ?? ''));
                    $colType = strtolower((string)($colRow['COLUMN_TYPE'] ?? ''));
                    if ($tbl === 'uploaded_videos') {
                        if ($col === 'ad_earnings') $schema['hasAdEarningsCol'] = true;
                        elseif ($col === 'is_blocked') $schema['hasIsBlockedCol'] = true;
                        elseif ($col === 'country_code') $schema['hasCountryCodeCol'] = true;
                        elseif ($col === 'promotion_payment_id') $schema['hasPromoPaymentIdCol'] = true;
                    } elseif ($tbl === 'payment_orders' && $col === 'promotion_applied_at') {
                        $schema['hasPromoAppliedAtCol'] = true;
                    } elseif ($tbl === 'global_pool_reserves' && $col === 'reserve_reason') {
                        if (str_contains($colType, 'insufficient_distributable_paise')) {
                            $schema['hasReserveReasonInsufficientEnum'] = true;
                        }
                    } elseif ($tbl === 'payment_transactions') {
                        if ($col === 'gst_amount') $schema['hasPtGstCol'] = true;
                        elseif ($col === 'pg_fee') $schema['hasPtPgFeeCol'] = true;
                        elseif ($col === 'referral_status') $schema['hasPtRefStatusCol'] = true;
                        elseif ($col === 'global_pool_distributed') $schema['hasPtPoolDistCol'] = true;
                        elseif ($col === 'global_pool_reserve') $schema['hasPtPoolResCol'] = true;
                        elseif ($col === 'global_pool_status') $schema['hasPtPoolStatusCol'] = true;
                    } elseif ($tbl === 'premium_transactions') {
                        if ($col === 'gst_amount') $schema['hasPremGstCol'] = true;
                        elseif ($col === 'pg_fee') $schema['hasPremPgFeeCol'] = true;
                        elseif ($col === 'referral_status') $schema['hasPremRefStatusCol'] = true;
                        elseif ($col === 'global_pool_distributed') $schema['hasPremPoolDistCol'] = true;
                        elseif ($col === 'global_pool_reserve') $schema['hasPremPoolResCol'] = true;
                        elseif ($col === 'global_pool_status') $schema['hasPremPoolStatusCol'] = true;
                    }
                }
            }
        } catch (Throwable $eColCheck) {
            error_log('[premium-settlement.php] Schema column metadata check failed: ' . $eColCheck->getMessage());
        }

        $schema['hasPtAccountingCols'] = ($schema['hasPtGstCol'] && $schema['hasPtPgFeeCol'] && $schema['hasPtRefStatusCol']);
        $schema['hasPtPoolBreakdownCols'] = ($schema['hasPtPoolDistCol'] && $schema['hasPtPoolResCol'] && $schema['hasPtPoolStatusCol']);
        $schema['hasPremAccountingCols'] = ($schema['hasPremGstCol'] && $schema['hasPremPgFeeCol'] && $schema['hasPremRefStatusCol']);
        $schema['hasPremPoolBreakdownCols'] = ($schema['hasPremPoolDistCol'] && $schema['hasPremPoolResCol'] && $schema['hasPremPoolStatusCol']);

        return $schema;
    }
}

if (!function_exists('ftValidateUploadedVideoAssetPhp')) {
    /**
     * Validates that a Sponsor video asset resolves strictly inside local uploads/videos storage
     * and exists as a readable non-empty video file (never publishing missing/incomplete videos).
     */
    function ftValidateUploadedVideoAssetPhp(string $rawVideoUrl): array {
        $trimmed = trim($rawVideoUrl);
        if ($trimmed === '' || in_array(strtolower($trimmed), ['null', 'undefined', 'nan'], true)) {
            return [
                'valid' => false,
                'status' => 422,
                'missingAsset' => 'video_url',
                'error' => 'Original uploaded video asset (videoUrl) is missing. Cannot publish an incomplete video.',
            ];
        }

        if (str_contains($trimmed, "\0") || preg_match('/^(blob:|data:|javascript:|file:)/i', $trimmed)) {
            return [
                'valid' => false,
                'status' => 400,
                'missingAsset' => 'video_url',
                'error' => 'Invalid video asset reference. Only verified uploaded server video files can be recovered.',
            ];
        }

        $rawPath = $trimmed;
        if (preg_match('/^https?:\/\//i', $trimmed)) {
            $parsed = @parse_url($trimmed);
            if (!is_array($parsed) || empty($parsed['host']) || empty($parsed['path'])) {
                return [
                    'valid' => false,
                    'status' => 400,
                    'missingAsset' => 'video_url',
                    'error' => 'Invalid video asset URL format.',
                ];
            }
            $urlHost = strtolower((string)$parsed['host']);
            $serverHost = strtolower(preg_replace('/:\d+$/', '', (string)($_SERVER['HTTP_HOST'] ?? ($_SERVER['SERVER_NAME'] ?? ''))));
            $allowedLocalHosts = array_filter([
                'api.facetube.online',
                'facetube.online',
                'www.facetube.online',
                'localhost',
                '127.0.0.1',
                $serverHost,
            ]);
            if (!in_array($urlHost, $allowedLocalHosts, true)) {
                return [
                    'valid' => false,
                    'status' => 422,
                    'missingAsset' => $trimmed,
                    'error' => 'External video URLs cannot be verified as an uploaded local asset. Provide the /uploads/videos/ file path from this server.',
                ];
            }
            $rawPath = (string)$parsed['path'];
        }

        $decodedPath = rawurldecode($rawPath);
        if (str_contains($decodedPath, "\0") || str_contains($decodedPath, '\\')) {
            return [
                'valid' => false,
                'status' => 400,
                'missingAsset' => 'video_url',
                'error' => 'Invalid characters in uploaded video asset path.',
            ];
        }

        $normPath = ltrim($decodedPath, '/');
        if (str_starts_with($normPath, 'uploads/videos/')) {
            $relativeSubpath = substr($normPath, strlen('uploads/videos/'));
        } elseif (!str_contains($normPath, '/') && preg_match('/^[a-zA-Z0-9._-]+$/', $normPath)) {
            $relativeSubpath = $normPath;
        } else {
            return [
                'valid' => false,
                'status' => 422,
                'missingAsset' => $decodedPath,
                'error' => 'Video asset must point to an uploaded file inside /uploads/videos/.',
            ];
        }

        if ($relativeSubpath === '' || str_starts_with($relativeSubpath, '/')) {
            return [
                'valid' => false,
                'status' => 422,
                'missingAsset' => '/uploads/videos/',
                'error' => 'Missing video filename in /uploads/videos/ asset path.',
            ];
        }

        $segments = explode('/', $relativeSubpath);
        foreach ($segments as $seg) {
            if ($seg === '' || $seg === '.' || $seg === '..') {
                return [
                    'valid' => false,
                    'status' => 403,
                    'missingAsset' => '/uploads/videos/' . $relativeSubpath,
                    'error' => 'Invalid path traversal segment in video asset path.',
                ];
            }
        }

        $ext = strtolower((string)pathinfo($relativeSubpath, PATHINFO_EXTENSION));
        $allowedExts = ['mp4', 'webm', 'ogg', 'mov', 'm4v', 'mkv'];
        if (!in_array($ext, $allowedExts, true)) {
            return [
                'valid' => false,
                'status' => 422,
                'missingAsset' => '/uploads/videos/' . $relativeSubpath,
                'error' => 'Unsupported or missing video file extension in upload asset path.',
            ];
        }

        $candidateDirs = [];
        $envUploadsOverride = trim((string)(getenv('FACETUBE_UPLOADS_DIR') ?: ($_ENV['FACETUBE_UPLOADS_DIR'] ?? '')));
        if ($envUploadsOverride !== '') {
            $candidateDirs[] = rtrim($envUploadsOverride, '/\\') . '/videos/';
        }
        foreach (getMediaStorageDirectories('videos') as $dir) {
            $candidateDirs[] = $dir;
        }

        foreach ($candidateDirs as $baseDir) {
            $realBase = @realpath($baseDir);
            if ($realBase === false || !is_dir($realBase)) {
                continue;
            }
            $realBasePrefix = rtrim($realBase, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR;
            $candidateFile = $realBasePrefix . implode(DIRECTORY_SEPARATOR, $segments);
            $realFile = @realpath($candidateFile);
            if ($realFile === false) {
                continue;
            }
            if (!str_starts_with($realFile, $realBasePrefix)) {
                return [
                    'valid' => false,
                    'status' => 403,
                    'missingAsset' => '/uploads/videos/' . $relativeSubpath,
                    'error' => 'Security rejection: Video asset resolves outside approved upload storage.',
                ];
            }
            if (!is_file($realFile) || !is_readable($realFile)) {
                continue;
            }
            $sizeBytes = @filesize($realFile);
            if ($sizeBytes === false || $sizeBytes <= 0) {
                return [
                    'valid' => false,
                    'status' => 422,
                    'missingAsset' => '/uploads/videos/' . $relativeSubpath,
                    'error' => "Uploaded video asset '/uploads/videos/{$relativeSubpath}' exists on disk but is empty (0 bytes). Cannot publish an incomplete video.",
                ];
            }
            return [
                'valid' => true,
                'status' => 200,
                'relativePath' => '/uploads/videos/' . $relativeSubpath,
                'publicUrl' => toAbsoluteMediaUrl('/uploads/videos/' . $relativeSubpath, 'videos'),
                'filePath' => $realFile,
                'sizeBytes' => (int)$sizeBytes,
            ];
        }

        return [
            'valid' => false,
            'status' => 422,
            'missingAsset' => '/uploads/videos/' . $relativeSubpath,
            'error' => "Original uploaded video file is missing on server storage (/uploads/videos/{$relativeSubpath}). Upload or restore the original video asset before publishing.",
        ];
    }
}

if (!function_exists('ftResolveDuplicateReferrerIdPhp')) {
    function ftResolveDuplicateReferrerIdPhp(PDO $conn, array $existingTx): ?string {
        $dupIsPremium = ($existingTx['purpose'] ?? '') === 'premium_video_upload';
        $dupRefStatus = !empty($existingTx['referral_status']) && $existingTx['referral_status'] !== 'not_applicable'
            ? (string)$existingTx['referral_status']
            : (floatval($existingTx['referral_commission'] ?? 0) > 0 ? 'credited' : 'unassigned_pending');
        if ($dupIsPremium && $dupRefStatus === 'unassigned_pending') {
            return null;
        }
        $payId = (string)($existingTx['payment_id'] ?? '');
        try {
            $stmtPt = $conn->prepare('SELECT referrer_id FROM premium_transactions WHERE payment_id = ? LIMIT 1');
            $stmtPt->execute([$payId]);
            $ptRow = $stmtPt->fetch(PDO::FETCH_ASSOC);
            $ptRef = trim((string)($ptRow['referrer_id'] ?? ''));
            if ($ptRef !== '') {
                return strtoupper($ptRef);
            }
        } catch (Throwable $_ePtRef) {
            // optional table
        }
        try {
            $txLookupId = (($existingTx['purpose'] ?? '') === 'ads_promotion')
                ? ('TX_ADS_L1_' . $payId)
                : ('TX_REF_' . $payId);
            $stmtLed = $conn->prepare("SELECT user_id FROM income_ledger WHERE transaction_id = ? AND user_id != 'UNASSIGNED_REFERRAL' LIMIT 1");
            $stmtLed->execute([$txLookupId]);
            $ledRow = $stmtLed->fetch(PDO::FETCH_ASSOC);
            $ledRef = trim((string)($ledRow['user_id'] ?? ''));
            if ($ledRef !== '') {
                return strtoupper($ledRef);
            }
        } catch (Throwable $_eLedRef) {
            // ignore
        }
        return null;
    }
}

if (!function_exists('ftBuildDuplicateVerifyResponsePhp')) {
    function ftBuildDuplicateVerifyResponsePhp(
        PDO $conn,
        array $existingTx,
        string $orderId,
        string $paymentId,
        string $uploaderId,
        string $videoId,
        string $purpose,
        string $message
    ): array {
        $txOrderMismatch = !empty($existingTx['order_id']) && (string)$existingTx['order_id'] !== $orderId;
        $txUserMismatch = strcasecmp((string)$existingTx['user_id'], $uploaderId) !== 0;
        $existingTxVideoId = trim((string)($existingTx['video_id'] ?? ''));
        $resolvedVideoId = trim($videoId);
        $txVideoMismatch = $existingTxVideoId !== '' && $existingTxVideoId !== $resolvedVideoId;
        if ($txOrderMismatch || $txUserMismatch || $txVideoMismatch || (string)$existingTx['purpose'] !== $purpose) {
            return [
                409,
                [
                    'verified' => false,
                    'paymentId' => $paymentId,
                    'orderId' => $orderId,
                    'error' => 'Conflict: Payment ID has already been used for a different order, video, or user.',
                ],
            ];
        }

        $dupIsPremium = ($existingTx['purpose'] === 'premium_video_upload');
        $dupGst = $dupIsPremium
            ? (isset($existingTx['gst_amount']) && floatval($existingTx['gst_amount']) > 0 ? floatval($existingTx['gst_amount']) : 0.90)
            : 0.00;
        $dupPg = $dupIsPremium
            ? (isset($existingTx['pg_fee']) && floatval($existingTx['pg_fee']) > 0 ? floatval($existingTx['pg_fee']) : 0.10)
            : 0.00;
        $dupRefStatus = $dupIsPremium
            ? (!empty($existingTx['referral_status']) && $existingTx['referral_status'] !== 'not_applicable'
                ? (string)$existingTx['referral_status']
                : (floatval($existingTx['referral_commission'] ?? 0) > 0 ? 'credited' : 'unassigned_pending'))
            : 'not_applicable';
        $dupPoolAllocated = floatval($existingTx['global_pool_allocation']);
        $dupPoolDistributed = $dupIsPremium
            ? (isset($existingTx['global_pool_distributed']) ? floatval($existingTx['global_pool_distributed']) : $dupPoolAllocated)
            : 0.00;
        $dupPoolReserve = $dupIsPremium
            ? (isset($existingTx['global_pool_reserve']) ? floatval($existingTx['global_pool_reserve']) : max(0.0, round($dupPoolAllocated - $dupPoolDistributed, 2)))
            : 0.00;
        $dupPoolStatus = $dupIsPremium
            ? (!empty($existingTx['global_pool_status']) && $existingTx['global_pool_status'] !== 'not_applicable'
                ? (string)$existingTx['global_pool_status']
                : ($dupPoolReserve <= 0 ? 'settled' : ($dupPoolDistributed <= 0 ? 'pending_reserve' : 'partial_reserve')))
            : 'not_applicable';
        $dupReferrerId = ftResolveDuplicateReferrerIdPhp($conn, $existingTx);

        $dist = [
            'directReferralAmount' => floatval($existingTx['referral_commission']),
            'referrerId' => $dupReferrerId,
            'referralStatus' => $dupRefStatus,
            'adminAmount' => floatval($existingTx['admin_allocation']),
            'globalPoolAmount' => $dupPoolAllocated,
        ];
        if ($dupIsPremium) {
            $dist['globalPoolDistributedAmount'] = $dupPoolDistributed;
            $dist['globalPoolReserveAmount'] = $dupPoolReserve;
            $dist['globalPoolStatus'] = $dupPoolStatus;
            $dist['gstAmount'] = $dupGst;
            $dist['pgFeeAmount'] = $dupPg;
            $dist['taxAndFees'] = round($dupGst + $dupPg, 2);
            $dist['totalAmount'] = floatval($existingTx['amount']);
        }

        return [
            200,
            [
                'verified' => true,
                'paymentId' => $existingTx['payment_id'],
                'orderId' => $existingTx['order_id'],
                'amount' => floatval($existingTx['amount']),
                'purpose' => $existingTx['purpose'],
                'txNumber' => intval($existingTx['tx_number']),
                'isSpecialTransaction' => (bool)$existingTx['is_special'],
                'specialTag' => $existingTx['special_tag'],
                'distribution' => $dist,
                'duplicate' => true,
                'message' => $message,
            ],
        ];
    }
}

if (!function_exists('ftSettlePremiumVideoMysqlPhp')) {
    /**
     * Executes atomic Phase 1.1 ₹6 Sponsor Video distribution & reserve creation inside an active PDO transaction.
     * Caller MUST hold transaction & row locks on payment_orders and payment_transactions before calling.
     */
    function ftSettlePremiumVideoMysqlPhp(PDO $pdo, array $schema, array $params): array {
        $orderId = (string)$params['orderId'];
        $paymentId = (string)$params['paymentId'];
        $userId = (string)$params['userId'];
        $userName = (string)$params['userName'];
        $videoId = (string)$params['videoId'];
        $amount = 6.00;
        $purpose = 'premium_video_upload';

        $stmtCount = $pdo->query("SELECT COUNT(*) as total FROM payment_transactions WHERE purpose = 'premium_video_upload' FOR UPDATE");
        $countRow = $stmtCount->fetch(PDO::FETCH_ASSOC);
        $txNumber = intval($countRow['total'] ?? 0) + 1;

        $isSpecial = false;
        $specialTag = 'NORMAL_PREMIUM';

        $verifiedReferrerId = null;
        $directSponsorMatch = resolveDirectSponsorUserPhp($pdo, $userId);
        if ($directSponsorMatch && !empty($directSponsorMatch['user_id'])) {
            $verifiedReferrerId = $directSponsorMatch['user_id'];
        }

        $stmtAdmin = $pdo->query("SELECT user_id FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1");
        $adminRow = $stmtAdmin ? $stmtAdmin->fetch(PDO::FETCH_ASSOC) : null;
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
        $adEarningsExpr = !empty($schema['hasAdEarningsCol']) ? 'COALESCE(ad_earnings, 0.00) AS ad_earnings' : '0.00 AS ad_earnings';
        $blockedFilter = !empty($schema['hasIsBlockedCol']) ? "\n                  AND (is_blocked = 0 OR is_blocked IS NULL)" : '';
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
            $distributedPaise = 0;
            $reservePaise = $poolPaise;
        } else {
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
            : (($eligibleVideoCount === 0)
                ? 'no_eligible_videos'
                : (($distributedPaise === 0) ? 'insufficient_distributable_paise' : 'rounding_residual'));
        $globalPoolReserveId = null;

        if ($reservePaise > 0 && empty($schema['hasGlobalPoolReservesTable'])) {
            return [
                'settled' => false,
                'status' => 503,
                'error' => 'Global Pool reserve schema migration has not been applied yet. Transaction safely rolled back.',
            ];
        }

        if (!empty($schema['hasPtAccountingCols']) && !empty($schema['hasPtPoolBreakdownCols'])) {
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
        } elseif (!empty($schema['hasPtAccountingCols'])) {
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

        try {
            $ptId = ftUuidV4Php();
            if (!empty($schema['hasPremAccountingCols']) && !empty($schema['hasPremPoolBreakdownCols'])) {
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
            } elseif (!empty($schema['hasPremAccountingCols'])) {
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
        } catch (Throwable $ePt) {
            if (!ftIsMissingOptionalTablePhp($ePt)) {
                throw $ePt;
            }
        }

        if (!empty($verifiedReferrerId)) {
            $txRefId = 'TX_REF_' . $paymentId;
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
                ftUuidV4Php(),
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
                ftUuidV4Php(),
                $txRefPendingId,
                $userId,
                $userName,
                $videoId ?: null,
                "Unassigned referral allocation (₹1.00 pending) — no valid referrer for Premium Video #{$txNumber} upload by {$userName} ({$userId})"
            ]);
        }

        if ($adminAllocation > 0) {
            $txAdmId = 'TX_ADM_' . $paymentId;
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
                ftUuidV4Php(),
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
                $glbDesc = "Per-Video Ads Earnings Share for video #{$payout['videoId']} (₹{$payout['amount']} share of ₹3 pool for Premium Video #{$txNumber})";
                $stmtGlbLedger->execute([
                    ftUuidV4Php(),
                    $txGlbId,
                    $payout['userId'],
                    $userId,
                    $userName,
                    $payout['videoId'],
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

        if ($reservePaise > 0 && $globalPoolReserveReason !== null) {
            $txGlbReserveId = 'TX_GLB_RESERVE_' . $paymentId;
            $reserveDesc = ($globalPoolReserveReason === 'no_eligible_videos')
                ? "Global Pool pending reserve (₹{$globalPoolReserve} — 0 eligible previous videos for Premium Video #{$txNumber})"
                : (($globalPoolReserveReason === 'insufficient_distributable_paise')
                    ? "Global Pool pending reserve (₹{$globalPoolReserve} — insufficient distributable paise across {$eligibleCreatorCount} eligible videos for Premium Video #{$txNumber})"
                    : "Global Pool pending reserve (₹{$globalPoolReserve} — integer-paise rounding residual for Premium Video #{$txNumber})");

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
                ftUuidV4Php(),
                $txGlbReserveId,
                $userId,
                $userName,
                $videoId ?: null,
                $globalPoolReserve,
                $reserveDesc
            ]);

            $globalPoolReserveId = 'gpr_' . round(microtime(true) * 1000) . '_' . substr(bin2hex(random_bytes(4)), 0, 8);
            $sqlReserveReason = ($globalPoolReserveReason === 'insufficient_distributable_paise' && empty($schema['hasReserveReasonInsufficientEnum']))
                ? 'rounding_residual'
                : $globalPoolReserveReason;
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
                $sqlReserveReason,
                $reserveDesc
            ]);
        }

        return [
            'settled' => true,
            'status' => 200,
            'txNumber' => $txNumber,
            'isSpecialTransaction' => $isSpecial,
            'specialTag' => $specialTag,
            'distribution' => [
                'directReferralAmount' => $referralCommission,
                'referrerId' => $verifiedReferrerId,
                'referralStatus' => $referralStatus,
                'adminAmount' => $adminAllocation,
                'adminPercent' => intval(round(($adminAllocation / $amount) * 100)),
                'globalPoolAmount' => $globalPoolAllocation,
                'globalPoolDistributedAmount' => $globalPoolDistributed,
                'globalPoolReserveAmount' => $globalPoolReserve,
                'globalPoolStatus' => $globalPoolStatus,
                'globalPoolReserveReason' => $globalPoolReserveReason,
                'globalPoolReserveId' => $globalPoolReserveId,
                'gstAmount' => $gstAmount,
                'pgFeeAmount' => $pgFeeAmount,
                'taxAndFees' => $taxAndFees,
                'totalAmount' => $amount,
                'eligibleMembersCount' => $eligibleCreatorCount,
                'perMemberShare' => $eligibleCreatorCount > 0 && !empty($creatorPayouts[0]) ? $creatorPayouts[0]['amount'] : 0.0,
                'creatorPayouts' => $creatorPayouts,
                'totalReferralAmount' => $referralCommission,
                'levelPayouts' => [],
                'missingLevels' => [],
            ],
        ];
    }
}

if (!function_exists('ftResolveThumbnailUrlForRecoveryPhp')) {
    function ftResolveThumbnailUrlForRecoveryPhp(string $videoId, string $category, string $rawThumbnailUrl = ''): string {
        $thumbnailUrl = trim($rawThumbnailUrl);
        if (in_array(strtolower($thumbnailUrl), ['null', 'undefined', 'nan'], true)) {
            $thumbnailUrl = '';
        }

        if ($thumbnailUrl !== '' && str_starts_with($thumbnailUrl, 'data:image/')) {
            $imgData = explode(',', $thumbnailUrl, 2);
            if (count($imgData) === 2) {
                $decoded = base64_decode($imgData[1], true);
                if ($decoded !== false && strlen($decoded) > 0) {
                    $imgUploadDir = ensureMediaStorageDir('images');
                    if ($imgUploadDir) {
                        $imgExt = 'jpg';
                        if (str_contains($imgData[0], 'png')) $imgExt = 'png';
                        elseif (str_contains($imgData[0], 'webp')) $imgExt = 'webp';

                        $safeVidId = preg_replace('/[^a-zA-Z0-9_-]/', '_', $videoId);
                        $imgFileName = 'thumb_' . $safeVidId . '.' . $imgExt;
                        $imgPath = $imgUploadDir . $imgFileName;
                        if (@file_put_contents($imgPath, $decoded)) {
                            $allDirs = getMediaStorageDirectories('images');
                            foreach ($allDirs as $otherDir) {
                                if ($otherDir !== $imgUploadDir && is_dir($otherDir) && is_writable($otherDir)) {
                                    @copy($imgPath, $otherDir . $imgFileName);
                                }
                            }
                            return toAbsoluteMediaUrl('/uploads/images/' . $imgFileName, 'images');
                        }
                    }
                }
            }
            $thumbnailUrl = '';
        }

        if ($thumbnailUrl === '' || strlen($thumbnailUrl) > 60000) {
            $categoryThumbnails = [
                'Cartoon' => 'https://images.unsplash.com/photo-1534447677768-be436bb09401?w=800&auto=format&fit=crop&q=80',
                'Agriculture' => 'https://images.unsplash.com/photo-1500937386664-56d1dfef3854?w=800&auto=format&fit=crop&q=80',
                'Coding' => 'https://images.unsplash.com/photo-1517694712202-14dd9538aa97?w=800&auto=format&fit=crop&q=80',
                'Motivational' => 'https://images.unsplash.com/photo-1522071820081-009f0129c71c?w=800&auto=format&fit=crop&q=80',
                'Comedy' => 'https://images.unsplash.com/photo-1514306191717-452ec28c7814?w=800&auto=format&fit=crop&q=80',
                'Blog' => 'https://images.unsplash.com/photo-1499750310107-5fef28a66643?w=800&auto=format&fit=crop&q=80',
                'Movie' => 'https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?w=800&auto=format&fit=crop&q=80',
                'Entertainment' => 'https://images.unsplash.com/photo-1598488035139-bdbb2231ce04?w=800&auto=format&fit=crop&q=80',
                'Cooking' => 'https://images.unsplash.com/photo-1556910103-1c02745aae4d?w=800&auto=format&fit=crop&q=80',
                'Finance' => 'https://images.unsplash.com/photo-1579621970563-ebec7560ff3e?w=800&auto=format&fit=crop&q=80',
                'Share Market' => 'https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?w=800&auto=format&fit=crop&q=80',
                'Business' => 'https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?w=800&auto=format&fit=crop&q=80',
                'Crypto' => 'https://images.unsplash.com/photo-1622979135225-d2ba269bc1df?w=800&auto=format&fit=crop&q=80',
                'Music' => 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=800&auto=format&fit=crop&q=80',
                'Gaming' => 'https://images.unsplash.com/photo-1538481199705-c710c4e965fc?w=800&auto=format&fit=crop&q=80',
                'Travel' => 'https://images.unsplash.com/photo-1488646953014-85cb44e25828?w=800&auto=format&fit=crop&q=80',
                'AI' => 'https://images.unsplash.com/photo-1677442136019-21780ecad995?w=800&auto=format&fit=crop&q=80',
                'Education' => 'https://images.unsplash.com/photo-1503676260728-1c00da094a0b?w=800&auto=format&fit=crop&q=80',
                'General' => 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=800&auto=format&fit=crop&q=60',
            ];
            $thumbnailUrl = $categoryThumbnails['General'];
            $trimmedCat = trim($category);
            foreach ($categoryThumbnails as $catKey => $catThumb) {
                if (strcasecmp($catKey, $trimmedCat) === 0) {
                    $thumbnailUrl = $catThumb;
                    break;
                }
            }
            return $thumbnailUrl;
        }

        return toAbsoluteMediaUrl($thumbnailUrl, 'images');
    }
}

if (!function_exists('ftUpsertRecoveredPremiumVideoMysqlPhp')) {
    /**
     * Publishes or updates uploaded_videos with verified ₹6 Sponsor paid state inside an active PDO transaction.
     */
    function ftUpsertRecoveredPremiumVideoMysqlPhp(PDO $pdo, array $schema, array $params): array {
        $videoId = (string)$params['videoId'];
        $userId = (string)$params['userId'];
        $creatorName = (string)$params['creatorName'];
        $title = (string)$params['title'];
        $description = (string)$params['description'];
        $videoUrl = (string)$params['videoUrl'];
        $thumbnailUrl = (string)$params['thumbnailUrl'];
        $contentType = (string)$params['contentType'];
        $category = (string)$params['category'];
        $duration = (string)$params['duration'];
        $visibility = (string)$params['visibility'];
        $paymentId = (string)$params['paymentId'];
        $paymentAmount = 6.00;
        $paymentStatus = 'paid';
        $videoType = 'premium';
        $existingVideo = $params['existingVideo'] ?? null;
        $hasCountryCodeCol = !empty($schema['hasCountryCodeCol']);
        $detectedCountryCode = (string)($params['detectedCountryCode'] ?? ftResolveTrustedRequestCountryCode());

        if ($hasCountryCodeCol) {
            $stmt = $pdo->prepare('
                INSERT INTO uploaded_videos (
                    id, user_id, creator_name, title, description, video_url, thumbnail_url,
                    video_type, content_type, category, duration, views, likes,
                    payment_status, payment_id, payment_amount, is_promoted, visibility, country_code,
                    created_at, updated_at
                ) VALUES (
                    ?, ?, ?, ?, ?, ?, ?,
                    ?, ?, ?, ?, 0, 0,
                    ?, ?, ?, 0, ?, ?,
                    NOW(), NOW()
                )
                ON DUPLICATE KEY UPDATE
                    creator_name = VALUES(creator_name),
                    title = VALUES(title),
                    description = VALUES(description),
                    video_url = VALUES(video_url),
                    thumbnail_url = VALUES(thumbnail_url),
                    video_type = VALUES(video_type),
                    content_type = VALUES(content_type),
                    category = VALUES(category),
                    duration = VALUES(duration),
                    payment_status = VALUES(payment_status),
                    payment_id = VALUES(payment_id),
                    payment_amount = VALUES(payment_amount),
                    visibility = VALUES(visibility),
                    updated_at = NOW()
            ');
            $stmt->execute([
                $videoId, $userId, $creatorName, $title, $description, $videoUrl, $thumbnailUrl,
                $videoType, $contentType, $category, $duration,
                $paymentStatus, $paymentId, $paymentAmount, $visibility, $detectedCountryCode
            ]);
        } else {
            $stmt = $pdo->prepare('
                INSERT INTO uploaded_videos (
                    id, user_id, creator_name, title, description, video_url, thumbnail_url,
                    video_type, content_type, category, duration, views, likes,
                    payment_status, payment_id, payment_amount, is_promoted, visibility,
                    created_at, updated_at
                ) VALUES (
                    ?, ?, ?, ?, ?, ?, ?,
                    ?, ?, ?, ?, 0, 0,
                    ?, ?, ?, 0, ?,
                    NOW(), NOW()
                )
                ON DUPLICATE KEY UPDATE
                    creator_name = VALUES(creator_name),
                    title = VALUES(title),
                    description = VALUES(description),
                    video_url = VALUES(video_url),
                    thumbnail_url = VALUES(thumbnail_url),
                    video_type = VALUES(video_type),
                    content_type = VALUES(content_type),
                    category = VALUES(category),
                    duration = VALUES(duration),
                    payment_status = VALUES(payment_status),
                    payment_id = VALUES(payment_id),
                    payment_amount = VALUES(payment_amount),
                    visibility = VALUES(visibility),
                    updated_at = NOW()
            ');
            $stmt->execute([
                $videoId, $userId, $creatorName, $title, $description, $videoUrl, $thumbnailUrl,
                $videoType, $contentType, $category, $duration,
                $paymentStatus, $paymentId, $paymentAmount, $visibility
            ]);
        }

        $persistedIsPromoted = is_array($existingVideo) ? (bool)($existingVideo['is_promoted'] ?? false) : false;
        $persistedCountryCode = is_array($existingVideo)
            ? ftNormalizeCountryCode($existingVideo['country_code'] ?? null)
            : ($hasCountryCodeCol ? $detectedCountryCode : FT_UNKNOWN_COUNTRY_CODE);

        return [
            'id' => $videoId,
            'userId' => $userId,
            'user_id' => $userId,
            'creatorName' => $creatorName,
            'creator_name' => $creatorName,
            'title' => $title,
            'description' => $description,
            'videoUrl' => $videoUrl,
            'video_url' => $videoUrl,
            'thumbnailUrl' => $thumbnailUrl,
            'thumbnail_url' => $thumbnailUrl,
            'videoType' => $videoType,
            'video_type' => $videoType,
            'contentType' => $contentType,
            'content_type' => $contentType,
            'category' => $category,
            'duration' => $duration,
            'visibility' => $visibility,
            'countryCode' => $persistedCountryCode,
            'country_code' => $persistedCountryCode,
            'paymentStatus' => $paymentStatus,
            'payment_status' => $paymentStatus,
            'paymentId' => $paymentId,
            'payment_id' => $paymentId,
            'paymentAmount' => $paymentAmount,
            'payment_amount' => $paymentAmount,
            'isPromoted' => $persistedIsPromoted,
            'is_promoted' => $persistedIsPromoted,
            'created_at' => is_array($existingVideo) ? ($existingVideo['created_at'] ?? date('c')) : date('c'),
        ];
    }
}
