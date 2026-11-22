<?php
/**
 * FaceTube - AdMob Reporting API v1 Shared Helper (Step 9C Phase 2.1)
 *
 * Strictly implements:
 * 1. AES-256-GCM refresh token decryption & OAuth 2.0 access token refresh (with invalid_grant handling)
 * 2. Live Google PublisherAccount INR currency & reportingTimeZone validation (fail-closed on invalid TZ)
 * 3. FaceTube Android App ID validation & APP-filtered networkReport:generate query
 * 4. Arbitrary-precision integer-micros string summation & 6-decimal INR conversion
 *    (Hostinger runtime target: PHP 8.x 64-bit; string arithmetic avoids 32-bit overflow as well)
 * 5. Concurrency-safe MySQL retry classification (1062 duplicate key, 1213 deadlock, 1205 lock timeout)
 *
 * Never modifies ADMOB_OAUTH_REDIRECT_URI or OAuth callback routing.
 * Never credits creator wallets or income_ledger.
 */

require_once __DIR__ . '/admob-crypto.php';

function readAdmobServerEnv(string $key): string {
    $val = getenv($key);
    if ($val === false) {
        $val = $_ENV[$key] ?? ($_SERVER[$key] ?? '');
    }
    return trim((string)$val);
}

function isAdmobConnectionUnavailableError(Throwable $e): bool {
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

/**
 * Detects bounded-retryable MySQL concurrency errors:
 * - 1062 (ER_DUP_ENTRY)
 * - 1213 (ER_LOCK_DEADLOCK / SQLSTATE 40001)
 * - 1205 (ER_LOCK_WAIT_TIMEOUT)
 */
function isAdmobRetryableConcurrencyError(Throwable $e): bool {
    $sqlState = $e instanceof PDOException ? (string)$e->getCode() : '';
    $driverCode = ($e instanceof PDOException && isset($e->errorInfo[1])) ? (int)$e->errorInfo[1] : 0;
    if (in_array($driverCode, [1062, 1213, 1205], true) || $sqlState === '40001') {
        return true;
    }
    $msg = $e->getMessage();
    return preg_match('/Duplicate entry|Deadlock found|Lock wait timeout/i', $msg) === 1;
}

/**
 * Strictly parses JSON request bodies.
 * Rejects malformed or non-object non-empty JSON payloads with HTTP 400
 * instead of silently falling back to an empty $_POST array.
 */
function readStrictAdmobJsonPayload(): array {
    $raw = file_get_contents('php://input');
    if ($raw === false || trim($raw) === '') {
        return [
            'ok' => true,
            'data' => is_array($_POST) ? $_POST : [],
        ];
    }

    $decoded = json_decode($raw, true);
    if (json_last_error() !== JSON_ERROR_NONE || !is_array($decoded) || array_is_list($decoded)) {
        return [
            'ok' => false,
            'status' => 400,
            'error' => 'Invalid JSON body',
        ];
    }

    return [
        'ok' => true,
        'data' => $decoded,
    ];
}

/**
 * Validates and resolves the strictly configured FaceTube Android AdMob App ID.
 * Rejects missing, malformed, test, or mismatched app IDs.
 */
function resolveFaceTubeAdmobAppId(?string $requestedAppId = null): array {
    $configuredAppId = readAdmobServerEnv('ADMOB_APP_ID');
    if ($configuredAppId === '') {
        return [
            'ok' => false,
            'status' => 500,
            'error' => 'FaceTube Android ADMOB_APP_ID is not configured on the server.'
        ];
    }

    if (preg_match('/^ca-app-pub-3940256099942544(?:~|\/|$)/i', $configuredAppId)) {
        return [
            'ok' => false,
            'status' => 400,
            'error' => 'Google reserved test AdMob App ID cannot be used for AdMob reporting.'
        ];
    }

    if (!preg_match('/^ca-app-pub-\d{16}~\d{10}$/', $configuredAppId)) {
        return [
            'ok' => false,
            'status' => 400,
            'error' => 'Configured ADMOB_APP_ID format is invalid. Expected ca-app-pub-XXXXXXXXXXXXXXXX~YYYYYYYYYY.'
        ];
    }

    $req = trim((string)($requestedAppId ?? ''));
    if ($req !== '' && $req !== $configuredAppId) {
        return [
            'ok' => false,
            'status' => 400,
            'error' => 'Only the configured FaceTube Android app ID is permitted in AdMob reporting.'
        ];
    }

    return [
        'ok' => true,
        'appId' => $configuredAppId
    ];
}

/**
 * Validates reportingTimeZone strictly.
 * Uses UTC ONLY when omitted (empty/null); never silently falls back to UTC on invalid strings.
 */
function validateAdmobReportingTimeZone(?string $reportingTimeZone, bool $allowEmptyDefaultUtc = true): array {
    $tzName = trim((string)($reportingTimeZone ?? ''));
    if ($tzName === '') {
        if ($allowEmptyDefaultUtc) {
            return [
                'ok' => true,
                'reportingTimeZone' => 'UTC',
                'dateTimeZone' => new DateTimeZone('UTC'),
            ];
        }
        return [
            'ok' => false,
            'status' => 422,
            'error' => 'AdMob reportingTimeZone is missing and cannot be safely established.',
        ];
    }

    try {
        $tz = new DateTimeZone($tzName);
        return [
            'ok' => true,
            'reportingTimeZone' => $tz->getName(),
            'dateTimeZone' => $tz,
        ];
    } catch (Throwable $e) {
        return [
            'ok' => false,
            'status' => 422,
            'error' => "Invalid AdMob reportingTimeZone '{$tzName}'. Refusing to fall back silently to UTC.",
        ];
    }
}

/**
 * Resolves the current YYYY-MM in the publisher's verified reportingTimeZone.
 */
function resolveDefaultAdmobReportMonth(string $reportingTimeZone): array {
    $tzRes = validateAdmobReportingTimeZone($reportingTimeZone, true);
    if (!$tzRes['ok']) {
        return $tzRes;
    }
    $nowInTz = new DateTimeImmutable('now', $tzRes['dateTimeZone']);
    return [
        'ok' => true,
        'reportMonth' => $nowInTz->format('Y-m'),
    ];
}

/**
 * Computes report date bounds and month-closure status in the publisher's reportingTimeZone.
 * Fails closed on invalid reportingTimeZone instead of silently falling back to UTC.
 */
function computeAdmobMonthPeriod(string $reportMonth, ?string $reportingTimeZone, bool $allowEmptyDefaultUtc = true): array {
    if (!preg_match('/^(\d{4})-(0[1-9]|1[0-2])$/', $reportMonth, $m)) {
        return [
            'ok' => false,
            'status' => 400,
            'error' => "Invalid reportMonth format '{$reportMonth}'. Expected YYYY-MM."
        ];
    }

    $tzRes = validateAdmobReportingTimeZone($reportingTimeZone, $allowEmptyDefaultUtc);
    if (!$tzRes['ok']) {
        return $tzRes;
    }
    $tzName = $tzRes['reportingTimeZone'];
    /** @var DateTimeZone $tz */
    $tz = $tzRes['dateTimeZone'];

    $year = (int)$m[1];
    $month = (int)$m[2];

    $nowInTz = new DateTimeImmutable('now', $tz);
    $curYear = (int)$nowInTz->format('Y');
    $curMonth = (int)$nowInTz->format('m');
    $curDay = (int)$nowInTz->format('d');

    if ($year > $curYear || ($year === $curYear && $month > $curMonth)) {
        return [
            'ok' => false,
            'status' => 400,
            'error' => "Cannot operate on future reporting month '{$reportMonth}'."
        ];
    }

    $isCurrentOpenMonth = ($year === $curYear && $month === $curMonth);
    $daysInMonth = (int)cal_days_in_month(CAL_GREGORIAN, $month, $year);
    $endDay = $isCurrentOpenMonth ? min($curDay, $daysInMonth) : $daysInMonth;

    $periodStart = sprintf('%04d-%02d-01', $year, $month);
    $periodEnd = sprintf('%04d-%02d-%02d', $year, $month, $endDay);

    return [
        'ok' => true,
        'reportMonth' => sprintf('%04d-%02d', $year, $month),
        'year' => $year,
        'month' => $month,
        'endDay' => $endDay,
        'periodStart' => $periodStart,
        'periodEnd' => $periodEnd,
        'isClosedMonth' => !$isCurrentOpenMonth,
        'reportingTimeZone' => $tzName,
    ];
}

function compareUnsignedIntStrings(string $a, string $b): int {
    $a = ltrim($a, '0');
    $b = ltrim($b, '0');
    if ($a === '') $a = '0';
    if ($b === '') $b = '0';
    if (strlen($a) !== strlen($b)) {
        return strlen($a) <=> strlen($b);
    }
    return strcmp($a, $b);
}

function addUnsignedIntStrings(string $a, string $b): string {
    $i = strlen($a) - 1;
    $j = strlen($b) - 1;
    $carry = 0;
    $out = '';
    while ($i >= 0 || $j >= 0 || $carry > 0) {
        $da = $i >= 0 ? (int)$a[$i] : 0;
        $db = $j >= 0 ? (int)$b[$j] : 0;
        $sum = $da + $db + $carry;
        $out = (string)($sum % 10) . $out;
        $carry = intdiv($sum, 10);
        $i--;
        $j--;
    }
    $trimmed = ltrim($out, '0');
    return $trimmed === '' ? '0' : $trimmed;
}

function subUnsignedIntStrings(string $larger, string $smaller): string {
    $i = strlen($larger) - 1;
    $j = strlen($smaller) - 1;
    $borrow = 0;
    $out = '';
    while ($i >= 0) {
        $da = (int)$larger[$i] - $borrow;
        $db = $j >= 0 ? (int)$smaller[$j] : 0;
        if ($da < $db) {
            $da += 10;
            $borrow = 1;
        } else {
            $borrow = 0;
        }
        $out = (string)($da - $db) . $out;
        $i--;
        $j--;
    }
    $trimmed = ltrim($out, '0');
    return $trimmed === '' ? '0' : $trimmed;
}

/**
 * Adds two arbitrary-length signed decimal integer strings without float conversion or 32/64-bit overflow.
 */
function addAdmobIntegerStrings(string $a, string $b): string {
    $a = trim($a);
    $b = trim($b);
    if (!preg_match('/^-?\d+$/', $a) || !preg_match('/^-?\d+$/', $b)) {
        throw new InvalidArgumentException('Invalid integer string for AdMob micros addition.');
    }
    if (function_exists('bcadd')) {
        return bcadd($a, $b, 0);
    }

    $negA = str_starts_with($a, '-');
    $negB = str_starts_with($b, '-');
    $magA = ltrim($negA ? substr($a, 1) : $a, '0') ?: '0';
    $magB = ltrim($negB ? substr($b, 1) : $b, '0') ?: '0';

    if ($negA === $negB) {
        $sum = addUnsignedIntStrings($magA, $magB);
        return ($negA && $sum !== '0') ? '-' . $sum : $sum;
    }

    $cmp = compareUnsignedIntStrings($magA, $magB);
    if ($cmp === 0) {
        return '0';
    }
    if ($cmp > 0) {
        $diff = subUnsignedIntStrings($magA, $magB);
        return $negA ? '-' . $diff : $diff;
    }
    $diff = subUnsignedIntStrings($magB, $magA);
    return $negB ? '-' . $diff : $diff;
}

/**
 * Formats signed integer micros (int or decimal string) to exact 6-decimal INR string without overflow or rounding.
 */
function formatAdmobMicrosToDecimal(int|string $micros): string {
    $str = trim((string)$micros);
    if (!preg_match('/^-?\d+$/', $str)) {
        throw new InvalidArgumentException('Invalid micros value for formatting.');
    }
    $neg = str_starts_with($str, '-');
    $mag = ltrim($neg ? substr($str, 1) : $str, '0');
    if ($mag === '') {
        return '0.000000';
    }
    $padded = str_pad($mag, 7, '0', STR_PAD_LEFT);
    $whole = substr($padded, 0, -6);
    $frac = substr($padded, -6);
    return ($neg ? '-' : '') . $whole . '.' . $frac;
}

/**
 * Refreshes an OAuth 2.0 access token using the stored encrypted refresh token.
 * Automatically marks credentials inactive if Google responds with invalid_grant.
 */
function refreshAdmobAccessToken(PDO $pdo, array $credRow, string $secretKey): array {
    $config = getAdmobOAuthConfig();
    if (!$config['isConfigured']) {
        return [
            'ok' => false,
            'status' => 500,
            'error' => 'Google AdMob OAuth client credentials are not configured on the server.'
        ];
    }

    $refreshToken = decryptSecret(
        (string)$credRow['encrypted_refresh_token'],
        (string)$credRow['refresh_token_iv'],
        (string)$credRow['refresh_token_tag'],
        $secretKey
    );

    if ($refreshToken === false || $refreshToken === '') {
        return [
            'ok' => false,
            'status' => 500,
            'error' => 'Failed to decrypt stored AdMob OAuth refresh token.'
        ];
    }

    $ch = curl_init('https://oauth2.googleapis.com/token');
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => http_build_query([
            'client_id' => $config['clientId'],
            'client_secret' => $config['clientSecret'],
            'refresh_token' => $refreshToken,
            'grant_type' => 'refresh_token',
        ]),
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => ['Content-Type: application/x-www-form-urlencoded'],
        CURLOPT_TIMEOUT => 20,
    ]);

    $raw = curl_exec($ch);
    $httpStatus = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $curlErr = curl_error($ch);
    curl_close($ch);

    if ($raw === false || $curlErr !== '') {
        error_log('[admob-reporting.php] Token refresh network error.');
        return [
            'ok' => false,
            'status' => 502,
            'error' => 'Network error refreshing Google AdMob OAuth access token.'
        ];
    }

    $json = json_decode($raw, true);
    if ($httpStatus !== 200 || !is_array($json) || empty($json['access_token'])) {
        $oauthErr = is_array($json) ? (string)($json['error'] ?? '') : '';
        $oauthDesc = is_array($json) ? (string)($json['error_description'] ?? $oauthErr) : 'Token refresh failed';

        if ($oauthErr === 'invalid_grant') {
            try {
                $stmtDeactivate = $pdo->prepare('UPDATE admob_oauth_credentials SET is_active = 0, updated_at = NOW() WHERE id = ?');
                $stmtDeactivate->execute([$credRow['id']]);
            } catch (Throwable $dbErr) {
                error_log('[admob-reporting.php] Failed to deactivate revoked AdMob credential: ' . $dbErr->getMessage());
            }

            return [
                'ok' => false,
                'status' => 401,
                'error' => 'Google AdMob OAuth refresh token expired or was revoked (invalid_grant). Please reconnect AdMob OAuth.'
            ];
        }

        error_log('[admob-reporting.php] Token refresh rejected by Google (HTTP ' . $httpStatus . ', error=' . $oauthErr . ').');
        return [
            'ok' => false,
            'status' => 502,
            'error' => 'Failed to refresh Google AdMob access token: ' . $oauthDesc
        ];
    }

    return [
        'ok' => true,
        'accessToken' => (string)$json['access_token'],
        'expiresIn' => (int)($json['expires_in'] ?? 3600),
    ];
}

/**
 * Fetches live PublisherAccount metadata from Google AdMob API and strictly verifies currencyCode === INR
 * plus a valid reportingTimeZone (allowing UTC only when genuinely omitted).
 */
function fetchAndVerifyGoogleAdmobAccount(string $publisherId, string $accessToken): array {
    $url = 'https://admob.googleapis.com/v1/accounts/' . rawurlencode($publisherId);
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_HTTPGET => true,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => [
            "Authorization: Bearer {$accessToken}",
            'Accept: application/json',
        ],
        CURLOPT_TIMEOUT => 20,
    ]);

    $raw = curl_exec($ch);
    $httpStatus = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $curlErr = curl_error($ch);
    curl_close($ch);

    if ($raw === false || $curlErr !== '') {
        return [
            'ok' => false,
            'status' => 502,
            'error' => 'Network error querying Google AdMob publisher account metadata.'
        ];
    }

    if ($httpStatus === 401) {
        return [
            'ok' => false,
            'status' => 401,
            'error' => 'Google AdMob API rejected the OAuth access token (HTTP 401).'
        ];
    }

    if ($httpStatus !== 200) {
        error_log('[admob-reporting.php] Google accounts.get returned HTTP ' . $httpStatus);
        return [
            'ok' => false,
            'status' => 502,
            'error' => 'Unable to verify Google AdMob publisher account metadata (HTTP ' . $httpStatus . ').'
        ];
    }

    $json = json_decode($raw, true);
    if (!is_array($json)) {
        return [
            'ok' => false,
            'status' => 502,
            'error' => 'Invalid JSON returned by Google AdMob accounts endpoint.'
        ];
    }

    $actualCurrency = strtoupper(trim((string)($json['currencyCode'] ?? '')));
    if ($actualCurrency === '') {
        return [
            'ok' => false,
            'status' => 422,
            'error' => 'Google AdMob publisher account metadata did not include currencyCode. Refusing to assume INR.'
        ];
    }

    if ($actualCurrency !== 'INR') {
        return [
            'ok' => false,
            'status' => 422,
            'error' => "Google AdMob publisher account currency is '{$actualCurrency}', expected 'INR'. FX conversion is not authorized; sync aborted."
        ];
    }

    $rawTimeZone = trim((string)($json['reportingTimeZone'] ?? ''));
    $tzRes = validateAdmobReportingTimeZone($rawTimeZone, true);
    if (!$tzRes['ok']) {
        return [
            'ok' => false,
            'status' => 422,
            'error' => "Google AdMob publisher account returned invalid reportingTimeZone '{$rawTimeZone}'. Refusing to fall back silently to UTC."
        ];
    }

    return [
        'ok' => true,
        'currencyCode' => $actualCurrency,
        'reportingTimeZone' => $tzRes['reportingTimeZone'],
    ];
}

/**
 * Generates an APP-filtered networkReport from Google AdMob API v1 and validates INR + APP scope.
 */
function fetchGoogleAdmobNetworkReport(
    string $publisherId,
    string $accessToken,
    string $appId,
    array $period
): array {
    $url = 'https://admob.googleapis.com/v1/accounts/' . rawurlencode($publisherId) . '/networkReport:generate';
    $payload = [
        'reportSpec' => [
            'dateRange' => [
                'startDate' => [
                    'year' => $period['year'],
                    'month' => $period['month'],
                    'day' => 1,
                ],
                'endDate' => [
                    'year' => $period['year'],
                    'month' => $period['month'],
                    'day' => $period['endDay'],
                ],
            ],
            'dimensions' => ['APP'],
            'metrics' => [
                'ESTIMATED_EARNINGS',
                'IMPRESSIONS',
                'CLICKS',
                'AD_REQUESTS',
                'MATCHED_REQUESTS',
            ],
            'dimensionFilters' => [
                [
                    'dimension' => 'APP',
                    'matchesAny' => [
                        'values' => [$appId],
                    ],
                ],
            ],
            'localizationSettings' => [
                'languageCode' => 'en-US',
            ],
        ],
    ];

    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => json_encode($payload, JSON_UNESCAPED_SLASHES),
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => [
            "Authorization: Bearer {$accessToken}",
            'Content-Type: application/json',
            'Accept: application/json',
        ],
        CURLOPT_TIMEOUT => 30,
    ]);

    $raw = curl_exec($ch);
    $httpStatus = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $curlErr = curl_error($ch);
    curl_close($ch);

    if ($raw === false || $curlErr !== '') {
        return [
            'ok' => false,
            'status' => 502,
            'error' => 'Network error fetching Google AdMob network report.'
        ];
    }

    if ($httpStatus === 429 || $httpStatus >= 500) {
        return [
            'ok' => false,
            'status' => 503,
            'error' => 'Google AdMob Reporting API temporarily unavailable or rate-limited (HTTP ' . $httpStatus . ').'
        ];
    }

    if ($httpStatus !== 200) {
        error_log('[admob-reporting.php] networkReport:generate failed with HTTP ' . $httpStatus);
        return [
            'ok' => false,
            'status' => $httpStatus === 401 ? 401 : 502,
            'error' => 'Google AdMob networkReport:generate request failed (HTTP ' . $httpStatus . ').'
        ];
    }

    $items = json_decode($raw, true);
    if (!is_array($items)) {
        return [
            'ok' => false,
            'status' => 502,
            'error' => 'Invalid JSON response from Google AdMob networkReport:generate.'
        ];
    }

    $headerCurrency = '';
    $totalMicros = '0';
    $impressions = 0;
    $clicks = 0;
    $adRequests = 0;
    $matchedRequests = 0;

    foreach ($items as $entry) {
        if (!is_array($entry)) {
            continue;
        }
        if (isset($entry['header']) && is_array($entry['header'])) {
            $headerCurrency = strtoupper(trim((string)($entry['header']['localizationSettings']['currencyCode'] ?? '')));
        }
        if (isset($entry['row']) && is_array($entry['row'])) {
            $row = $entry['row'];
            $rowAppId = trim((string)($row['dimensionValues']['APP']['value'] ?? ''));
            if ($rowAppId !== $appId) {
                return [
                    'ok' => false,
                    'status' => 422,
                    'error' => 'Google AdMob report returned a non-FaceTube app row; sync aborted by app scope policy.'
                ];
            }

            $metrics = $row['metricValues'] ?? [];
            $rawMicros = trim((string)($metrics['ESTIMATED_EARNINGS']['microsValue'] ?? '0'));
            if (!preg_match('/^-?\d+$/', $rawMicros)) {
                return [
                    'ok' => false,
                    'status' => 502,
                    'error' => 'Invalid ESTIMATED_EARNINGS microsValue returned by Google AdMob.'
                ];
            }
            $totalMicros = addAdmobIntegerStrings($totalMicros, $rawMicros);
            $impressions += max(0, (int)($metrics['IMPRESSIONS']['integerValue'] ?? 0));
            $clicks += max(0, (int)($metrics['CLICKS']['integerValue'] ?? 0));
            $adRequests += max(0, (int)($metrics['AD_REQUESTS']['integerValue'] ?? 0));
            $matchedRequests += max(0, (int)($metrics['MATCHED_REQUESTS']['integerValue'] ?? 0));
        }
    }

    if ($headerCurrency === '') {
        return [
            'ok' => false,
            'status' => 422,
            'error' => 'Google AdMob report header omitted localizationSettings.currencyCode. Refusing to assume INR.'
        ];
    }

    if ($headerCurrency !== 'INR') {
        return [
            'ok' => false,
            'status' => 422,
            'error' => "Google AdMob report currency is '{$headerCurrency}', expected 'INR'. Sync aborted."
        ];
    }

    return [
        'ok' => true,
        'currencyCode' => $headerCurrency,
        'estimatedEarningsMicros' => $totalMicros,
        'estimatedEarningsDecimal' => formatAdmobMicrosToDecimal($totalMicros),
        'impressions' => max(0, $impressions),
        'clicks' => max(0, $clicks),
        'adRequests' => max(0, $adRequests),
        'matchedRequests' => max(0, $matchedRequests),
    ];
}
