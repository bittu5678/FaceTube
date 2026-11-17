<?php
/**
 * FaceTube - Admin KYC Submissions Listing API (Hostinger / cPanel PHP Production)
 * GET /api/admin/kyc/list.php
 * Strictly restricted to verified administrators.
 */

require_once __DIR__ . '/../../config/database.php';
require_once __DIR__ . '/../../response.php';

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    jsonResponse(['success' => false, 'error' => 'Method Not Allowed'], 405);
}

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
        'error' => 'Admin authorization required. Access denied.'
    ], 403);
}

$typeFilter = strtolower(trim($_GET['type'] ?? 'all'));
$statusFilter = strtolower(trim($_GET['status'] ?? 'submitted'));
$search = trim($_GET['search'] ?? '');
$page = max(1, (int)($_GET['page'] ?? 1));
$limit = min(100, max(1, (int)($_GET['limit'] ?? 20)));
$userIdFilter = trim($_GET['userId'] ?? ($_GET['user_id'] ?? ''));

$allSubmissions = [];
$seen = [];

// Helper to sanitize submission record
function formatPersonalKycRow($row) {
    return [
        'id' => (string)($row['id'] ?? ('pkyc_' . ($row['user_id'] ?? ''))),
        'type' => 'personal',
        'userId' => (string)($row['user_id'] ?? ''),
        'fullName' => (string)($row['full_name'] ?? ($row['fullName'] ?? '')),
        'mobile' => (string)($row['mobile'] ?? ''),
        'dob' => (string)($row['dob'] ?? ''),
        'address' => (string)($row['address'] ?? ''),
        'city' => (string)($row['city'] ?? ''),
        'state' => (string)($row['state'] ?? ''),
        'pincode' => (string)($row['pincode'] ?? ''),
        'nomineeName' => (string)($row['nominee_name'] ?? ($row['nomineeName'] ?? '')),
        'nomineeRelation' => (string)($row['nominee_relation'] ?? ($row['nomineeRelation'] ?? '')),
        'nomineeMobile' => (string)($row['nominee_mobile'] ?? ($row['nomineeMobile'] ?? '')),
        'status' => (string)($row['status'] ?? 'Submitted'),
        'reviewedBy' => !empty($row['reviewed_by']) ? (string)$row['reviewed_by'] : (!empty($row['reviewedBy']) ? (string)$row['reviewedBy'] : null),
        'reviewedAt' => !empty($row['reviewed_at']) ? (string)$row['reviewed_at'] : (!empty($row['reviewedAt']) ? (string)$row['reviewedAt'] : null),
        'adminNote' => !empty($row['admin_note']) ? (string)$row['admin_note'] : (!empty($row['adminNote']) ? (string)$row['adminNote'] : null),
        'rejectionReason' => !empty($row['rejection_reason']) ? (string)$row['rejection_reason'] : (!empty($row['rejectionReason']) ? (string)$row['rejectionReason'] : null),
        'submittedAt' => (string)($row['created_at'] ?? ($row['submittedAt'] ?? ($row['updated_at'] ?? gmdate('Y-m-d\TH:i:s\Z')))),
        'updatedAt' => (string)($row['updated_at'] ?? ($row['updatedAt'] ?? gmdate('Y-m-d\TH:i:s\Z'))),
    ];
}

function formatBankKycRow($row) {
    return [
        'id' => (string)($row['id'] ?? ('bkyc_' . ($row['user_id'] ?? ''))),
        'type' => 'bank',
        'userId' => (string)($row['user_id'] ?? ''),
        'accountHolderName' => (string)($row['account_holder_name'] ?? ($row['accountHolderName'] ?? ($row['accountHolder'] ?? ''))),
        'bankName' => (string)($row['bank_name'] ?? ($row['bankName'] ?? '')),
        'accountNumber' => (string)($row['account_number'] ?? ($row['accountNumber'] ?? '')),
        'ifscCode' => (string)($row['ifsc_code'] ?? ($row['ifscCode'] ?? '')),
        'branchName' => (string)($row['branch_name'] ?? ($row['branchName'] ?? '')),
        'accountType' => (string)($row['account_type'] ?? ($row['accountType'] ?? 'Saving')),
        'upiId' => (string)($row['upi_id'] ?? ($row['upiId'] ?? '')),
        'upiQrCodeUrl' => (string)($row['upi_qr_code'] ?? ($row['upiQrCodeUrl'] ?? '')),
        'status' => (string)($row['status'] ?? 'Submitted'),
        'reviewedBy' => !empty($row['reviewed_by']) ? (string)$row['reviewed_by'] : (!empty($row['reviewedBy']) ? (string)$row['reviewedBy'] : null),
        'reviewedAt' => !empty($row['reviewed_at']) ? (string)$row['reviewed_at'] : (!empty($row['reviewedAt']) ? (string)$row['reviewedAt'] : null),
        'adminNote' => !empty($row['admin_note']) ? (string)$row['admin_note'] : (!empty($row['adminNote']) ? (string)$row['adminNote'] : null),
        'rejectionReason' => !empty($row['rejection_reason']) ? (string)$row['rejection_reason'] : (!empty($row['rejectionReason']) ? (string)$row['rejectionReason'] : null),
        'submittedAt' => (string)($row['created_at'] ?? ($row['submittedAt'] ?? ($row['updated_at'] ?? gmdate('Y-m-d\TH:i:s\Z')))),
        'updatedAt' => (string)($row['updated_at'] ?? ($row['updatedAt'] ?? gmdate('Y-m-d\TH:i:s\Z'))),
    ];
}

// 1. Load from MySQL database if connection exists
if ($pdo) {
    try {
        if ($typeFilter === 'all' || $typeFilter === 'personal') {
            $stmt = $pdo->query('SELECT * FROM personal_kyc ORDER BY updated_at DESC');
            $pRows = $stmt ? $stmt->fetchAll(PDO::FETCH_ASSOC) : [];
            foreach ($pRows as $r) {
                $item = formatPersonalKycRow($r);
                $key = 'personal_' . strtoupper($item['userId']);
                if (empty($seen[$key])) {
                    $seen[$key] = true;
                    $allSubmissions[] = $item;
                }
            }
        }
    } catch (Exception $e) {
        // Fallback to legacy kyc_records
        try {
            $stmt = $pdo->query('SELECT * FROM kyc_records ORDER BY updated_at DESC');
            $pRows = $stmt ? $stmt->fetchAll(PDO::FETCH_ASSOC) : [];
            foreach ($pRows as $r) {
                $item = formatPersonalKycRow($r);
                $key = 'personal_' . strtoupper($item['userId']);
                if (empty($seen[$key])) {
                    $seen[$key] = true;
                    $allSubmissions[] = $item;
                }
            }
        } catch (Exception $e2) {
            // Safe fallback
        }
    }

    try {
        if ($typeFilter === 'all' || $typeFilter === 'bank') {
            $stmt = $pdo->query('SELECT * FROM bank_kyc ORDER BY updated_at DESC');
            $bRows = $stmt ? $stmt->fetchAll(PDO::FETCH_ASSOC) : [];
            foreach ($bRows as $r) {
                $item = formatBankKycRow($r);
                $key = 'bank_' . strtoupper($item['userId']);
                if (empty($seen[$key])) {
                    $seen[$key] = true;
                    $allSubmissions[] = $item;
                }
            }
        }
    } catch (Exception $e) {
        // Fallback to legacy kyc_bank_details
        try {
            $stmt = $pdo->query('SELECT * FROM kyc_bank_details ORDER BY updated_at DESC');
            $bRows = $stmt ? $stmt->fetchAll(PDO::FETCH_ASSOC) : [];
            foreach ($bRows as $r) {
                $item = formatBankKycRow($r);
                $key = 'bank_' . strtoupper($item['userId']);
                if (empty($seen[$key])) {
                    $seen[$key] = true;
                    $allSubmissions[] = $item;
                }
            }
        } catch (Exception $e2) {
            // Safe fallback
        }
    }
}

// 2. Merge with data/facetube_store.json (local / preview store)
$storeFile = __DIR__ . '/../../../data/facetube_store.json';
if (file_exists($storeFile)) {
    $store = json_decode(file_get_contents($storeFile), true);
    if (!empty($store['personalKyc']) && is_array($store['personalKyc']) && ($typeFilter === 'all' || $typeFilter === 'personal')) {
        foreach ($store['personalKyc'] as $uId => $r) {
            $key = 'personal_' . strtoupper($uId);
            if (empty($seen[$key]) && is_array($r)) {
                $seen[$key] = true;
                $r['user_id'] = $r['userId'] ?? $uId;
                $allSubmissions[] = formatPersonalKycRow($r);
            }
        }
    }
    if (!empty($store['bankKyc']) && is_array($store['bankKyc']) && ($typeFilter === 'all' || $typeFilter === 'bank')) {
        foreach ($store['bankKyc'] as $uId => $r) {
            $key = 'bank_' . strtoupper($uId);
            if (empty($seen[$key]) && is_array($r)) {
                $seen[$key] = true;
                $r['user_id'] = $r['userId'] ?? $uId;
                $allSubmissions[] = formatBankKycRow($r);
            }
        }
    }
}

// Compute aggregate metrics
$stats = [
    'totalPending' => 0,
    'pendingPersonal' => 0,
    'pendingBank' => 0,
    'totalVerified' => 0,
    'totalRejected' => 0,
    'totalSubmissions' => count($allSubmissions),
];

foreach ($allSubmissions as $sub) {
    $st = strtolower($sub['status']);
    if ($st === 'submitted' || $st === 'pending') {
        $stats['totalPending']++;
        if ($sub['type'] === 'personal') {
            $stats['pendingPersonal']++;
        } else {
            $stats['pendingBank']++;
        }
    } elseif ($st === 'verified') {
        $stats['totalVerified']++;
    } elseif ($st === 'rejected') {
        $stats['totalRejected']++;
    }
}

// Filter submissions
$filtered = array_filter($allSubmissions, function($item) use ($typeFilter, $statusFilter, $search, $userIdFilter) {
    if ($typeFilter !== 'all' && strtolower($item['type']) !== $typeFilter) {
        return false;
    }

    if ($statusFilter !== 'all') {
        $itemStatus = strtolower($item['status']);
        if ($statusFilter === 'submitted' || $statusFilter === 'pending') {
            if ($itemStatus !== 'submitted' && $itemStatus !== 'pending') return false;
        } else {
            if ($itemStatus !== $statusFilter) return false;
        }
    }

    if (!empty($userIdFilter)) {
        if (strtoupper($item['userId']) !== strtoupper($userIdFilter)) {
            return false;
        }
    }

    if (!empty($search)) {
        $searchLower = strtolower($search);
        $blob = strtolower(implode(' ', [
            $item['userId'] ?? '',
            $item['fullName'] ?? '',
            $item['accountHolderName'] ?? '',
            $item['mobile'] ?? '',
            $item['bankName'] ?? '',
            $item['upiId'] ?? '',
        ]));
        if (strpos($blob, $searchLower) === false) {
            return false;
        }
    }

    return true;
});

// Sort: Pending/Submitted first, then newest updated
usort($filtered, function($a, $b) {
    $aSubmitted = (strtolower($a['status']) === 'submitted' || strtolower($a['status']) === 'pending') ? 1 : 0;
    $bSubmitted = (strtolower($b['status']) === 'submitted' || strtolower($b['status']) === 'pending') ? 1 : 0;
    if ($aSubmitted !== $bSubmitted) {
        return $bSubmitted - $aSubmitted;
    }
    return strcmp($b['updatedAt'] ?? '', $a['updatedAt'] ?? '');
});

$totalItems = count($filtered);
$totalPages = max(1, (int)ceil($totalItems / $limit));
$offset = ($page - 1) * $limit;
$paginated = array_slice($filtered, $offset, $limit);

jsonResponse([
    'success' => true,
    'stats' => $stats,
    'pagination' => [
        'page' => $page,
        'limit' => $limit,
        'totalItems' => $totalItems,
        'totalPages' => $totalPages,
    ],
    'submissions' => array_values($paginated),
]);
