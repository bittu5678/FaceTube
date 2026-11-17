<?php
/**
 * FaceTube - Temporary PHP Runtime Diagnostic Endpoint
 * GET /api/admin/php-diagnostic.php
 *
 * Strictly read-only, access-restricted diagnostic endpoint.
 * Requires authenticated Admin session.
 * Exposes only safe, allowlisted runtime limits and boolean capability flags.
 * Never outputs credentials, server paths, environment variables, or phpinfo().
 * Performs zero filesystem mutations (no mkdir, no file writes, no chmod).
 */

require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/../response.php';

// 1. Strictly accept GET requests only. Reject all other HTTP methods with 405.
if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    jsonResponse([
        'success' => false,
        'error' => 'Method Not Allowed. Only GET requests are accepted.'
    ], 405);
}

// 2. Authenticate user and verify administrator authorization.
try {
    $pdo = getDatabaseConnection();
    $authUser = getAuthUser($pdo);
} catch (Throwable $e) {
    jsonResponse([
        'success' => false,
        'error' => 'Database authorization check failed.'
    ], 500);
}

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

// 3. Collect allowlisted PHP runtime configuration values.
$uploadMaxFilesize = (string)(ini_get('upload_max_filesize') ?: '0');
$postMaxSize       = (string)(ini_get('post_max_size') ?: '0');
$memoryLimit       = (string)(ini_get('memory_limit') ?: '0');
$maxExecutionTime  = (string)(ini_get('max_execution_time') !== false ? ini_get('max_execution_time') : '0');
$maxInputTime      = (string)(ini_get('max_input_time') !== false ? ini_get('max_input_time') : '0');
$maxFileUploads    = (string)(ini_get('max_file_uploads') !== false ? ini_get('max_file_uploads') : '0');

// 4. File uploads enabled flag (boolean only).
$rawFileUploads = ini_get('file_uploads');
$fileUploadsEnabled = !empty($rawFileUploads) && !in_array(strtolower((string)$rawFileUploads), ['0', 'off', 'false', 'no'], true);

// 5. Temporary upload directory status (distinguishes configured vs effective; boolean only, no absolute paths).
$rawUploadTmpDir = (string)(ini_get('upload_tmp_dir') ?: '');
$uploadTmpDirIsConfigured = !empty(trim($rawUploadTmpDir));

// Check if the explicitly configured directory exists and is writable
$configuredUploadTmpDirWritable = $uploadTmpDirIsConfigured 
    && is_dir($rawUploadTmpDir) 
    && is_writable($rawUploadTmpDir);

// Check if the effective directory PHP uses (configured or system fallback) is writable
$effectiveTmpDir = $uploadTmpDirIsConfigured ? $rawUploadTmpDir : sys_get_temp_dir();
$effectiveUploadTmpDirWritable = !empty($effectiveTmpDir) 
    && is_dir($effectiveTmpDir) 
    && is_writable($effectiveTmpDir);

// 6. FaceTube video storage directory status (strictly read-only resolution; boolean only, no absolute paths).
// Reuses getMediaStorageDirectories('videos') from response.php without calling mkdir or mutating the filesystem.
$videoStorageWritable = false;
$candidateDirs = function_exists('getMediaStorageDirectories')
    ? getMediaStorageDirectories('videos')
    : [__DIR__ . '/../uploads/videos/'];

// Evaluate candidate storage directories in the exact priority order of the production upload handler
foreach ($candidateDirs as $candidate) {
    if (!empty($candidate) && is_dir($candidate) && is_writable($candidate)) {
        $videoStorageWritable = true;
        break;
    }
}

// 7. Emit sanitized diagnostic payload.
jsonResponse([
    'success' => true,
    'diagnostic' => [
        'php_version'                         => PHP_VERSION,
        'upload_max_filesize'                 => $uploadMaxFilesize,
        'post_max_size'                       => $postMaxSize,
        'memory_limit'                        => $memoryLimit,
        'max_execution_time'                  => $maxExecutionTime,
        'max_input_time'                      => $maxInputTime,
        'max_file_uploads'                    => $maxFileUploads,
        'file_uploads_enabled'                => $fileUploadsEnabled,
        'upload_tmp_dir_is_configured'        => $uploadTmpDirIsConfigured,
        'configured_upload_tmp_dir_writable'  => $configuredUploadTmpDirWritable,
        'effective_upload_tmp_dir_writable'   => $effectiveUploadTmpDirWritable,
        'video_storage_writable'              => $videoStorageWritable,
    ],
]);
