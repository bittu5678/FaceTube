<?php
/**
 * FaceTube - List Paid Subscriber Plans API
 * GET /api/subscriptions/plans.php
 * Authenticated endpoint for active subscriber membership plans.
 */

require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/../response.php';

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

// Baseline fallback plans matching migration definitions
$baselinePlans = [
    [
        'id' => 1,
        'plan_id' => 'member-monthly',
        'name' => 'Creator Member',
        'price' => 49.00,
        'duration_days' => 30,
        'perks' => [
            'Custom channel member badge',
            'Early access to new videos',
            'Exclusive member-only live stream chat'
        ],
        'is_active' => true,
        'created_at' => '2026-11-04 00:00:00',
    ],
    [
        'id' => 2,
        'plan_id' => 'member-vip-monthly',
        'name' => 'VIP Supporter',
        'price' => 149.00,
        'duration_days' => 30,
        'perks' => [
            'All Creator Member perks',
            'Priority comment replies',
            'Exclusive behind-the-scenes content',
            'VIP live badge'
        ],
        'is_active' => true,
        'created_at' => '2026-11-04 00:00:00',
    ],
    [
        'id' => 3,
        'plan_id' => 'member-annual',
        'name' => 'All-Access Annual',
        'price' => 999.00,
        'duration_days' => 365,
        'perks' => [
            'Full VIP access for 1 full year',
            '16% savings vs monthly',
            'Special Gold Supporter badge on all videos'
        ],
        'is_active' => true,
        'created_at' => '2026-11-04 00:00:00',
    ],
];

$isAdmin = isset($authUser['role']) && strtolower($authUser['role']) === 'admin';
$includeInactive = $isAdmin && isset($_GET['include_inactive']) && $_GET['include_inactive'] === '1';

try {
    $sql = 'SELECT id, plan_id, name, price, duration_days, perks_json, is_active, created_at FROM subscriber_plans';
    if (!$includeInactive) {
        $sql .= ' WHERE is_active = 1';
    }
    $sql .= ' ORDER BY price ASC';

    $stmt = $pdo->query($sql);
    $rows = $stmt->fetchAll();

    if ($rows !== false) {
        $formatted = array_map(function ($row) {
            $perks = [];
            if (!empty($row['perks_json'])) {
                $decoded = json_decode($row['perks_json'], true);
                if (is_array($decoded)) {
                    $perks = $decoded;
                }
            }
            return [
                'id' => (int)$row['id'],
                'plan_id' => (string)$row['plan_id'],
                'name' => (string)$row['name'],
                'price' => (float)$row['price'],
                'duration_days' => (int)$row['duration_days'],
                'perks' => $perks,
                'is_active' => (bool)$row['is_active'],
                'created_at' => (string)$row['created_at'],
            ];
        }, $rows);

        jsonResponse([
            'success' => true,
            'source' => 'database',
            'plans' => $formatted,
        ]);
    }
} catch (PDOException $e) {
    // If the subscriber_plans table has not been migrated yet (SQLSTATE 42S02 / Error 1146),
    // gracefully fall back to baseline plans to preserve platform continuity.
    $sqlState = $e->getCode();
    if ($sqlState !== '42S02' && !str_contains($e->getMessage(), "Table") && !str_contains($e->getMessage(), "doesn't exist")) {
        jsonResponse([
            'success' => false,
            'error' => 'Database error while fetching subscriber plans: ' . $e->getMessage()
        ], 500);
    }
}

// Return formatted baseline fallback plans
jsonResponse([
    'success' => true,
    'source' => 'baseline_fallback',
    'plans' => $baselinePlans,
]);
