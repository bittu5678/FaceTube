<?php
/**
 * FaceTube - Live Chat Messages API
 * GET /api/live/chat.php?stream_id=xyz
 * POST /api/live/chat.php
 */

require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/../response.php';

$pdo = getDatabaseConnection();
$method = $_SERVER['REQUEST_METHOD'];

$formatChatRow = static function (array $row): array {
    $rawAvatar = trim((string)($row['avatar_url'] ?? ''));
    $avatarUrl = $rawAvatar !== '' ? toAbsoluteMediaUrl($rawAvatar, 'logos') : null;
    if ($avatarUrl === '') {
        $avatarUrl = null;
    }

    return [
        'id' => (string)($row['id'] ?? ''),
        'stream_id' => (string)($row['stream_id'] ?? ''),
        'user_name' => trim((string)($row['user_name'] ?? '')) ?: 'Viewer',
        'avatar_url' => $avatarUrl,
        'message' => (string)($row['message'] ?? ''),
        'is_superchat' => !empty($row['is_superchat']) && floatval($row['superchat_amount'] ?? 0) > 0,
        'superchat_amount' => round(floatval($row['superchat_amount'] ?? 0), 2),
        'created_at' => (string)($row['created_at'] ?? date('c')),
    ];
};

if ($method === 'GET') {
    $streamId = trim($_GET['stream_id'] ?? ($_GET['streamId'] ?? ''));
    if ($streamId === '' || strlen($streamId) > 64) {
        jsonResponse(['success' => false, 'error' => 'stream_id parameter is required'], 400);
    }

    try {
        $stmt = $pdo->prepare('
            SELECT id, stream_id, user_name, avatar_url, message, is_superchat, superchat_amount, created_at
            FROM live_chat_messages
            WHERE stream_id = ?
            ORDER BY created_at ASC
            LIMIT 200
        ');
        $stmt->execute([$streamId]);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
        $messages = array_map($formatChatRow, is_array($rows) ? $rows : []);

        jsonResponse([
            'success' => true,
            'stream_id' => $streamId,
            'messages' => $messages,
        ]);
    } catch (Throwable $e) {
        error_log('[FaceTube LiveChat] Failed to load chat messages: ' . $e->getMessage());
        jsonResponse(['success' => false, 'error' => 'Database error while loading live chat messages'], 500);
    }
}

if ($method === 'POST') {
    $authUser = getAuthUser($pdo);
    $input = getRequestPayload();
    if (!is_array($input)) {
        jsonResponse(['success' => false, 'error' => 'Invalid JSON request body'], 400);
    }

    $streamId = trim((string)($input['stream_id'] ?? ($input['streamId'] ?? '')));
    $message = trim((string)($input['message'] ?? ''));

    if ($streamId === '' || $message === '') {
        jsonResponse(['success' => false, 'error' => 'stream_id and message are required'], 400);
    }
    if (strlen($streamId) > 64) {
        jsonResponse(['success' => false, 'error' => 'Invalid stream_id'], 400);
    }
    $msgLen = function_exists('mb_strlen') ? mb_strlen($message, 'UTF-8') : strlen($message);
    if ($msgLen > 500) {
        jsonResponse(['success' => false, 'error' => 'Message cannot exceed 500 characters'], 400);
    }

    // Authoritative sender identity (never trust client-supplied user_id or user_name)
    if ($authUser) {
        $userId = (string)$authUser['user_id'];
        $nameCandidate = trim((string)($authUser['name'] ?? ''));
        $channelCandidate = trim((string)($authUser['channel_name'] ?? ''));
        $userName = $nameCandidate !== '' ? $nameCandidate : ($channelCandidate !== '' ? $channelCandidate : 'FaceTube Member');

        $rawAvatar = trim((string)($authUser['avatar_url'] ?? ($authUser['channel_logo_url'] ?? '')));
        $avatarUrl = $rawAvatar !== '' ? toAbsoluteMediaUrl($rawAvatar, 'logos') : null;
        if ($avatarUrl === '') {
            $avatarUrl = null;
        }
    } else {
        $ip = substr(trim((string)($_SERVER['HTTP_CF_CONNECTING_IP'] ?? ($_SERVER['HTTP_X_FORWARDED_FOR'] ?? ($_SERVER['REMOTE_ADDR'] ?? '0.0.0.0')))), 0, 128);
        $ua = substr(trim((string)($_SERVER['HTTP_USER_AGENT'] ?? 'browser')), 0, 256);
        $guestHash = substr(hash('sha256', 'facetube_live_guest|' . $ip . '|' . $ua), 0, 12);
        $userId = 'guest_' . $guestHash;
        $userName = 'Viewer #' . strtoupper(substr($guestHash, 0, 4));
        $avatarUrl = null;
    }

    // SuperChat requires verified server-side payment linkage; never trust client-supplied SuperChat fields.
    $isSuperchat = false;
    $superchatAmount = 0.0;
    $msgId = 'chat_' . round(microtime(true) * 1000) . '_' . bin2hex(random_bytes(3));

    try {
        $rateStmt = $pdo->prepare('
            SELECT COUNT(*)
            FROM live_chat_messages
            WHERE stream_id = ? AND user_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL 10 SECOND)
        ');
        $rateStmt->execute([$streamId, $userId]);
        $recentCount = (int)$rateStmt->fetchColumn();
        if ($recentCount >= 20) {
            jsonResponse(['success' => false, 'error' => 'You are sending messages too quickly. Please wait a moment.'], 429);
        }

        $stmt = $pdo->prepare('
            INSERT INTO live_chat_messages (id, stream_id, user_id, user_name, avatar_url, message, is_superchat, superchat_amount, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())
        ');
        $insertOk = $stmt->execute([
            $msgId,
            $streamId,
            $userId,
            $userName,
            $avatarUrl,
            $message,
            0,
            0.0,
        ]);
        if (!$insertOk || $stmt->rowCount() < 1) {
            throw new RuntimeException('Live chat insert affected 0 rows.');
        }

        jsonResponse([
            'success' => true,
            'message' => $formatChatRow([
                'id' => $msgId,
                'stream_id' => $streamId,
                'user_name' => $userName,
                'avatar_url' => $avatarUrl,
                'message' => $message,
                'is_superchat' => $isSuperchat ? 1 : 0,
                'superchat_amount' => $superchatAmount,
                'created_at' => date('c'),
            ])
        ], 201);
    } catch (Throwable $e) {
        error_log('[FaceTube LiveChat] Failed to persist chat message: ' . $e->getMessage());
        jsonResponse(['success' => false, 'error' => 'Database error while saving live chat message'], 500);
    }
}

jsonResponse(['success' => false, 'error' => 'Method Not Allowed'], 405);
