<?php
/**
 * FaceTube - Admin Platform Settings API
 * GET /api/admin/settings.php - Retrieve platform settings
 * POST /api/admin/settings.php - Update platform settings (restricted to Admin)
 */

require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/../response.php';

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
        'error' => 'Admin authorization required.'
    ], 403);
}

// -----------------------------------------------------------------------------
// GET: Fetch Platform Settings
// -----------------------------------------------------------------------------
if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $settings = [
        'marketing_income_percentage' => 10.0,
        'ads_referral_rates' => [
            1 => 15,
            2 => 10,
            3 => 5,
            4 => 4,
            5 => 3,
            6 => 2,
            7 => 1,
        ]
    ];

    try {
        $stmt = $pdo->query('SELECT setting_key, setting_value FROM platform_settings');
        $rows = $stmt->fetchAll();
        foreach ($rows as $row) {
            $key = $row['setting_key'];
            $val = $row['setting_value'];
            if ($key === 'marketing_income_percentage') {
                $settings['marketing_income_percentage'] = floatval($val);
            } elseif ($key === 'adsense_client_id') {
                $settings['adsense_client_id'] = strval($val);
            } elseif ($key === 'adsense_slot_watch') {
                $settings['adsense_slot_watch'] = strval($val);
            } elseif ($key === 'adsense_slot_sidebar') {
                $settings['adsense_slot_sidebar'] = strval($val);
            } elseif ($key === 'adsense_slot_feed') {
                $settings['adsense_slot_feed'] = strval($val);
            } elseif ($key === 'adsense_enabled') {
                $settings['adsense_enabled'] = ($val === '1' || $val === 'true');
            } elseif (preg_match('/^ads_referral_rate_l([1-7])$/', $key, $m)) {
                $lvl = intval($m[1]);
                $settings['ads_referral_rates'][$lvl] = intval($val);
            }
        }
    } catch (PDOException $e) {
        // Fallback to defaults if table is not yet created
    }

    jsonResponse([
        'success' => true,
        'settings' => $settings
    ]);
}

// -----------------------------------------------------------------------------
// POST: Update Platform Settings
// -----------------------------------------------------------------------------
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $input = getRequestPayload();

    $marketingPct = isset($input['marketing_income_percentage']) 
        ? floatval($input['marketing_income_percentage']) 
        : (isset($input['marketingIncomePercentage']) ? floatval($input['marketingIncomePercentage']) : null);

    $adsenseClientId = isset($input['adsense_client_id']) 
        ? trim($input['adsense_client_id']) 
        : (isset($input['adsenseClientId']) ? trim($input['adsenseClientId']) : null);

    $adsenseSlotWatch = isset($input['adsense_slot_watch']) 
        ? trim($input['adsense_slot_watch']) 
        : (isset($input['adsenseSlotWatch']) ? trim($input['adsenseSlotWatch']) : null);

    $adsenseSlotSidebar = isset($input['adsense_slot_sidebar']) 
        ? trim($input['adsense_slot_sidebar']) 
        : (isset($input['adsenseSlotSidebar']) ? trim($input['adsenseSlotSidebar']) : null);

    $adsenseSlotFeed = isset($input['adsense_slot_feed']) 
        ? trim($input['adsense_slot_feed']) 
        : (isset($input['adsenseSlotFeed']) ? trim($input['adsenseSlotFeed']) : null);

    $adsenseEnabled = isset($input['adsense_enabled']) 
        ? ($input['adsense_enabled'] ? '1' : '0') 
        : (isset($input['adsenseEnabled']) ? ($input['adsenseEnabled'] ? '1' : '0') : null);

    if ($marketingPct !== null || $adsenseClientId !== null || $adsenseSlotWatch !== null || $adsenseSlotSidebar !== null || $adsenseSlotFeed !== null || $adsenseEnabled !== null) {
        if ($marketingPct !== null && ($marketingPct < 0 || $marketingPct > 100)) {
            jsonResponse([
                'success' => false,
                'error' => 'Marketing income percentage must be between 0% and 100%.'
            ], 400);
        }

        try {
            // Ensure table exists
            $pdo->exec("
                CREATE TABLE IF NOT EXISTS `platform_settings` (
                  `setting_key` VARCHAR(100) NOT NULL,
                  `setting_value` TEXT NOT NULL,
                  `description` VARCHAR(255) DEFAULT NULL,
                  `updated_by` VARCHAR(50) DEFAULT 'SYSTEM',
                  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                  PRIMARY KEY (`setting_key`)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            ");

            $stmtUpsert = $pdo->prepare("
                INSERT INTO platform_settings (setting_key, setting_value, description, updated_by, updated_at)
                VALUES (?, ?, ?, ?, NOW())
                ON DUPLICATE KEY UPDATE 
                    setting_value = VALUES(setting_value),
                    updated_by = VALUES(updated_by),
                    updated_at = NOW()
            ");

            if ($marketingPct !== null) {
                $stmtUpsert->execute(['marketing_income_percentage', strval($marketingPct), 'Default marketing commission percentage', $authUser['user_id']]);
            }
            if ($adsenseClientId !== null) {
                $stmtUpsert->execute(['adsense_client_id', $adsenseClientId, 'Google AdSense Publisher Client ID', $authUser['user_id']]);
            }
            if ($adsenseSlotWatch !== null) {
                $stmtUpsert->execute(['adsense_slot_watch', $adsenseSlotWatch, 'Google AdSense Watch Page Banner Slot ID', $authUser['user_id']]);
            }
            if ($adsenseSlotSidebar !== null) {
                $stmtUpsert->execute(['adsense_slot_sidebar', $adsenseSlotSidebar, 'Google AdSense Sidebar Slot ID', $authUser['user_id']]);
            }
            if ($adsenseSlotFeed !== null) {
                $stmtUpsert->execute(['adsense_slot_feed', $adsenseSlotFeed, 'Google AdSense Home Feed Banner Slot ID', $authUser['user_id']]);
            }
            if ($adsenseEnabled !== null) {
                $stmtUpsert->execute(['adsense_enabled', $adsenseEnabled, 'Google AdSense Global Enabled Flag', $authUser['user_id']]);
            }

            jsonResponse([
                'success' => true,
                'message' => "Platform settings successfully updated.",
                'marketing_income_percentage' => $marketingPct
            ]);
        } catch (PDOException $e) {
            jsonResponse([
                'success' => false,
                'error' => 'Database error updating settings: ' . $e->getMessage()
            ], 500);
        }
    }

    jsonResponse([
        'success' => false,
        'error' => 'No valid settings provided to update.'
    ], 400);
}

jsonResponse(['success' => false, 'error' => 'Method Not Allowed'], 405);
