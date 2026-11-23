<?php
/**
 * FaceTube - Trusted Server-Side Country Detection & ISO 3166-1 Alpha-2 Helpers
 */

const FT_UNKNOWN_COUNTRY_CODE = 'UNKNOWN';
const FT_UNKNOWN_COUNTRY_NAME = 'Unknown / Unassigned';

function ftGetIsoCountryNames(): array {
    static $countries = [
        'AD' => 'Andorra',
        'AE' => 'United Arab Emirates',
        'AF' => 'Afghanistan',
        'AG' => 'Antigua and Barbuda',
        'AI' => 'Anguilla',
        'AL' => 'Albania',
        'AM' => 'Armenia',
        'AO' => 'Angola',
        'AQ' => 'Antarctica',
        'AR' => 'Argentina',
        'AS' => 'American Samoa',
        'AT' => 'Austria',
        'AU' => 'Australia',
        'AW' => 'Aruba',
        'AX' => 'Aland Islands',
        'AZ' => 'Azerbaijan',
        'BA' => 'Bosnia and Herzegovina',
        'BB' => 'Barbados',
        'BD' => 'Bangladesh',
        'BE' => 'Belgium',
        'BF' => 'Burkina Faso',
        'BG' => 'Bulgaria',
        'BH' => 'Bahrain',
        'BI' => 'Burundi',
        'BJ' => 'Benin',
        'BL' => 'Saint Barthelemy',
        'BM' => 'Bermuda',
        'BN' => 'Brunei',
        'BO' => 'Bolivia',
        'BQ' => 'Bonaire, Sint Eustatius and Saba',
        'BR' => 'Brazil',
        'BS' => 'Bahamas',
        'BT' => 'Bhutan',
        'BV' => 'Bouvet Island',
        'BW' => 'Botswana',
        'BY' => 'Belarus',
        'BZ' => 'Belize',
        'CA' => 'Canada',
        'CC' => 'Cocos (Keeling) Islands',
        'CD' => 'Congo (DRC)',
        'CF' => 'Central African Republic',
        'CG' => 'Congo',
        'CH' => 'Switzerland',
        'CI' => "Cote d'Ivoire",
        'CK' => 'Cook Islands',
        'CL' => 'Chile',
        'CM' => 'Cameroon',
        'CN' => 'China',
        'CO' => 'Colombia',
        'CR' => 'Costa Rica',
        'CU' => 'Cuba',
        'CV' => 'Cabo Verde',
        'CW' => 'Curacao',
        'CX' => 'Christmas Island',
        'CY' => 'Cyprus',
        'CZ' => 'Czechia',
        'DE' => 'Germany',
        'DJ' => 'Djibouti',
        'DK' => 'Denmark',
        'DM' => 'Dominica',
        'DO' => 'Dominican Republic',
        'DZ' => 'Algeria',
        'EC' => 'Ecuador',
        'EE' => 'Estonia',
        'EG' => 'Egypt',
        'EH' => 'Western Sahara',
        'ER' => 'Eritrea',
        'ES' => 'Spain',
        'ET' => 'Ethiopia',
        'FI' => 'Finland',
        'FJ' => 'Fiji',
        'FK' => 'Falkland Islands',
        'FM' => 'Micronesia',
        'FO' => 'Faroe Islands',
        'FR' => 'France',
        'GA' => 'Gabon',
        'GB' => 'United Kingdom',
        'GD' => 'Grenada',
        'GE' => 'Georgia',
        'GF' => 'French Guiana',
        'GG' => 'Guernsey',
        'GH' => 'Ghana',
        'GI' => 'Gibraltar',
        'GL' => 'Greenland',
        'GM' => 'Gambia',
        'GN' => 'Guinea',
        'GP' => 'Guadeloupe',
        'GQ' => 'Equatorial Guinea',
        'GR' => 'Greece',
        'GS' => 'South Georgia and the South Sandwich Islands',
        'GT' => 'Guatemala',
        'GU' => 'Guam',
        'GW' => 'Guinea-Bissau',
        'GY' => 'Guyana',
        'HK' => 'Hong Kong',
        'HM' => 'Heard Island and McDonald Islands',
        'HN' => 'Honduras',
        'HR' => 'Croatia',
        'HT' => 'Haiti',
        'HU' => 'Hungary',
        'ID' => 'Indonesia',
        'IE' => 'Ireland',
        'IL' => 'Israel',
        'IM' => 'Isle of Man',
        'IN' => 'India',
        'IO' => 'British Indian Ocean Territory',
        'IQ' => 'Iraq',
        'IR' => 'Iran',
        'IS' => 'Iceland',
        'IT' => 'Italy',
        'JE' => 'Jersey',
        'JM' => 'Jamaica',
        'JO' => 'Jordan',
        'JP' => 'Japan',
        'KE' => 'Kenya',
        'KG' => 'Kyrgyzstan',
        'KH' => 'Cambodia',
        'KI' => 'Kiribati',
        'KM' => 'Comoros',
        'KN' => 'Saint Kitts and Nevis',
        'KP' => 'North Korea',
        'KR' => 'South Korea',
        'KW' => 'Kuwait',
        'KY' => 'Cayman Islands',
        'KZ' => 'Kazakhstan',
        'LA' => 'Laos',
        'LB' => 'Lebanon',
        'LC' => 'Saint Lucia',
        'LI' => 'Liechtenstein',
        'LK' => 'Sri Lanka',
        'LR' => 'Liberia',
        'LS' => 'Lesotho',
        'LT' => 'Lithuania',
        'LU' => 'Luxembourg',
        'LV' => 'Latvia',
        'LY' => 'Libya',
        'MA' => 'Morocco',
        'MC' => 'Monaco',
        'MD' => 'Moldova',
        'ME' => 'Montenegro',
        'MF' => 'Saint Martin',
        'MG' => 'Madagascar',
        'MH' => 'Marshall Islands',
        'MK' => 'North Macedonia',
        'ML' => 'Mali',
        'MM' => 'Myanmar',
        'MN' => 'Mongolia',
        'MO' => 'Macao',
        'MP' => 'Northern Mariana Islands',
        'MQ' => 'Martinique',
        'MR' => 'Mauritania',
        'MS' => 'Montserrat',
        'MT' => 'Malta',
        'MU' => 'Mauritius',
        'MV' => 'Maldives',
        'MW' => 'Malawi',
        'MX' => 'Mexico',
        'MY' => 'Malaysia',
        'MZ' => 'Mozambique',
        'NA' => 'Namibia',
        'NC' => 'New Caledonia',
        'NE' => 'Niger',
        'NF' => 'Norfolk Island',
        'NG' => 'Nigeria',
        'NI' => 'Nicaragua',
        'NL' => 'Netherlands',
        'NO' => 'Norway',
        'NP' => 'Nepal',
        'NR' => 'Nauru',
        'NU' => 'Niue',
        'NZ' => 'New Zealand',
        'OM' => 'Oman',
        'PA' => 'Panama',
        'PE' => 'Peru',
        'PF' => 'French Polynesia',
        'PG' => 'Papua New Guinea',
        'PH' => 'Philippines',
        'PK' => 'Pakistan',
        'PL' => 'Poland',
        'PM' => 'Saint Pierre and Miquelon',
        'PN' => 'Pitcairn',
        'PR' => 'Puerto Rico',
        'PS' => 'Palestine',
        'PT' => 'Portugal',
        'PW' => 'Palau',
        'PY' => 'Paraguay',
        'QA' => 'Qatar',
        'RE' => 'Reunion',
        'RO' => 'Romania',
        'RS' => 'Serbia',
        'RU' => 'Russia',
        'RW' => 'Rwanda',
        'SA' => 'Saudi Arabia',
        'SB' => 'Solomon Islands',
        'SC' => 'Seychelles',
        'SD' => 'Sudan',
        'SE' => 'Sweden',
        'SG' => 'Singapore',
        'SH' => 'Saint Helena',
        'SI' => 'Slovenia',
        'SJ' => 'Svalbard and Jan Mayen',
        'SK' => 'Slovakia',
        'SL' => 'Sierra Leone',
        'SM' => 'San Marino',
        'SN' => 'Senegal',
        'SO' => 'Somalia',
        'SR' => 'Suriname',
        'SS' => 'South Sudan',
        'ST' => 'Sao Tome and Principe',
        'SV' => 'El Salvador',
        'SX' => 'Sint Maarten',
        'SY' => 'Syria',
        'SZ' => 'Eswatini',
        'TC' => 'Turks and Caicos Islands',
        'TD' => 'Chad',
        'TF' => 'French Southern Territories',
        'TG' => 'Togo',
        'TH' => 'Thailand',
        'TJ' => 'Tajikistan',
        'TK' => 'Tokelau',
        'TL' => 'Timor-Leste',
        'TM' => 'Turkmenistan',
        'TN' => 'Tunisia',
        'TO' => 'Tonga',
        'TR' => 'Turkey',
        'TT' => 'Trinidad and Tobago',
        'TV' => 'Tuvalu',
        'TW' => 'Taiwan',
        'TZ' => 'Tanzania',
        'UA' => 'Ukraine',
        'UG' => 'Uganda',
        'UM' => 'United States Minor Outlying Islands',
        'US' => 'United States',
        'UY' => 'Uruguay',
        'UZ' => 'Uzbekistan',
        'VA' => 'Vatican City',
        'VC' => 'Saint Vincent and the Grenadines',
        'VE' => 'Venezuela',
        'VG' => 'British Virgin Islands',
        'VI' => 'U.S. Virgin Islands',
        'VN' => 'Vietnam',
        'VU' => 'Vanuatu',
        'WF' => 'Wallis and Futuna',
        'WS' => 'Samoa',
        'YE' => 'Yemen',
        'YT' => 'Mayotte',
        'ZA' => 'South Africa',
        'ZM' => 'Zambia',
        'ZW' => 'Zimbabwe',
    ];
    return $countries;
}

function ftNormalizeCountryCode($raw): string {
    if (!is_string($raw)) {
        return FT_UNKNOWN_COUNTRY_CODE;
    }
    $cleaned = strtoupper(trim($raw));
    if (preg_match('/^[A-Z]{2}$/', $cleaned) !== 1) {
        return FT_UNKNOWN_COUNTRY_CODE;
    }
    $countries = ftGetIsoCountryNames();
    return array_key_exists($cleaned, $countries) ? $cleaned : FT_UNKNOWN_COUNTRY_CODE;
}

function ftGetCountryName($rawCode): string {
    $code = ftNormalizeCountryCode($rawCode);
    if ($code === FT_UNKNOWN_COUNTRY_CODE) {
        return FT_UNKNOWN_COUNTRY_NAME;
    }
    $countries = ftGetIsoCountryNames();
    return $countries[$code] ?? FT_UNKNOWN_COUNTRY_NAME;
}

function ftStripIpv4MappedPrefix(string $ip): string {
    $trimmed = trim($ip);
    if (stripos($trimmed, '::ffff:') === 0) {
        $candidate = substr($trimmed, 7);
        if (filter_var($candidate, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4) !== false) {
            return $candidate;
        }
    }
    return $trimmed;
}

function ftIsIpInCidr(string $ip, string $cidr): bool {
    $ip = ftStripIpv4MappedPrefix($ip);
    if (strpos($cidr, '/') === false) {
        $normCidrIp = ftStripIpv4MappedPrefix($cidr);
        return $ip !== '' && strcasecmp($ip, $normCidrIp) === 0;
    }

    [$subnet, $prefixStr] = explode('/', $cidr, 2);
    $subnet = ftStripIpv4MappedPrefix($subnet);
    if (!ctype_digit($prefixStr)) {
        return false;
    }
    $prefix = (int)$prefixStr;

    $ipBin = @inet_pton($ip);
    $subnetBin = @inet_pton($subnet);
    if ($ipBin === false || $subnetBin === false || strlen($ipBin) !== strlen($subnetBin)) {
        return false;
    }

    $maxBits = strlen($ipBin) * 8;
    if ($prefix < 0 || $prefix > $maxBits) {
        return false;
    }

    $fullBytes = intdiv($prefix, 8);
    $remBits = $prefix % 8;

    if ($fullBytes > 0 && substr($ipBin, 0, $fullBytes) !== substr($subnetBin, 0, $fullBytes)) {
        return false;
    }
    if ($remBits > 0) {
        $mask = (0xFF << (8 - $remBits)) & 0xFF;
        if ((ord($ipBin[$fullBytes]) & $mask) !== (ord($subnetBin[$fullBytes]) & $mask)) {
            return false;
        }
    }
    return true;
}

function ftIsTrustedCloudflareIp(string $rawIp): bool {
    $ip = ftStripIpv4MappedPrefix($rawIp);
    if (filter_var($ip, FILTER_VALIDATE_IP) === false) {
        return false;
    }

    static $cloudflareCidrs = [
        // Official Cloudflare IPv4 CIDRs
        '173.245.48.0/20',
        '103.21.244.0/22',
        '103.22.200.0/22',
        '103.31.4.0/22',
        '141.101.64.0/18',
        '108.162.192.0/18',
        '190.93.240.0/20',
        '188.114.96.0/20',
        '197.234.240.0/22',
        '198.41.128.0/17',
        '162.158.0.0/15',
        '104.16.0.0/13',
        '104.24.0.0/14',
        '172.64.0.0/13',
        '131.0.72.0/22',
        // Official Cloudflare IPv6 CIDRs
        '2400:cb00::/32',
        '2606:4700::/32',
        '2803:f800::/32',
        '2405:b500::/32',
        '2405:8100::/32',
        '2a06:98c0::/29',
        '2c0f:f248::/32',
    ];

    foreach ($cloudflareCidrs as $cidr) {
        if (ftIsIpInCidr($ip, $cidr)) {
            return true;
        }
    }
    return false;
}

function ftReadEnvFlag(string $name): string {
    $val = getenv($name);
    if ($val !== false && trim((string)$val) !== '') {
        return trim((string)$val);
    }
    if (isset($_ENV[$name]) && trim((string)$_ENV[$name]) !== '') {
        return trim((string)$_ENV[$name]);
    }
    if (isset($_SERVER[$name]) && trim((string)$_SERVER[$name]) !== '') {
        return trim((string)$_SERVER[$name]);
    }
    return '';
}

function ftIsTrustedCloudflareRequest(): bool {
    $remoteAddr = ftStripIpv4MappedPrefix((string)($_SERVER['REMOTE_ADDR'] ?? ''));

    // 1. Direct peer IP matches Cloudflare's official published IP ranges
    if ($remoteAddr !== '' && ftIsTrustedCloudflareIp($remoteAddr)) {
        return true;
    }

    // 2. Shared Cloudflare Origin Transform Secret (if configured on server & Cloudflare)
    $originSecret = ftReadEnvFlag('CLOUDFLARE_ORIGIN_SECRET');
    $headerSecret = trim((string)($_SERVER['HTTP_X_CF_ORIGIN_SECRET'] ?? ''));
    if ($originSecret !== '' && $headerSecret !== '' && hash_equals($originSecret, $headerSecret)) {
        return true;
    }

    // 3. Explicit intermediate trusted proxy IPs (only when operator explicitly opts in)
    $trustProxy = strtolower(ftReadEnvFlag('TRUST_CLOUDFLARE_PROXY')) === 'true';
    $trustedProxyIpsRaw = ftReadEnvFlag('TRUSTED_PROXY_IPS');
    if ($trustProxy && $trustedProxyIpsRaw !== '' && $remoteAddr !== '') {
        $hasCfRay = trim((string)($_SERVER['HTTP_CF_RAY'] ?? '')) !== '';
        if ($hasCfRay) {
            foreach (explode(',', $trustedProxyIpsRaw) as $candidateCidr) {
                $trimmedCidr = trim($candidateCidr);
                if ($trimmedCidr !== '' && ftIsIpInCidr($remoteAddr, $trimmedCidr)) {
                    return true;
                }
            }
        }
    }

    return false;
}

/**
 * Resolves the uploader's country using trusted server-side sources only.
 * Never trusts client-supplied X-Forwarded-For, custom country headers, or payload fields.
 */
function ftResolveTrustedRequestCountryCode(): string {
    // 1. Trusted Cloudflare infrastructure header CF-IPCountry
    if (ftIsTrustedCloudflareRequest()) {
        $cfCountry = $_SERVER['HTTP_CF_IPCOUNTRY'] ?? '';
        $normalized = ftNormalizeCountryCode($cfCountry);
        if ($normalized !== FT_UNKNOWN_COUNTRY_CODE) {
            return $normalized;
        }
        return FT_UNKNOWN_COUNTRY_CODE;
    }

    // 2. Optional server-side PHP GeoIP extension lookup using direct public REMOTE_ADDR only
    $remoteAddr = ftStripIpv4MappedPrefix((string)($_SERVER['REMOTE_ADDR'] ?? ''));
    if (
        $remoteAddr !== ''
        && filter_var($remoteAddr, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) !== false
        && function_exists('geoip_country_code_by_name')
    ) {
        $geoCode = @geoip_country_code_by_name($remoteAddr);
        $normalized = ftNormalizeCountryCode($geoCode);
        if ($normalized !== FT_UNKNOWN_COUNTRY_CODE) {
            return $normalized;
        }
    }

    return FT_UNKNOWN_COUNTRY_CODE;
}
