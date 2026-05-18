package com.beppeaudiobooks.pipertts

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Build
import android.os.IBinder
import android.util.Base64
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.media.session.MediaButtonReceiver
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat

/**
 * Foreground service hosting a MediaSession for lock-screen / notification
 * controls. Minimal port of the previous PiperPlaybackService (from the
 * patched sherpa wrapper) — we only need:
 *   - Foreground notification with cover + title + play/pause + skip buttons
 *   - MediaSession that broadcasts PLAY/PAUSE/NEXT/PREVIOUS back to JS via
 *     RCTDeviceEventEmitter event "piperMediaAction".
 */
class PiperPlaybackService : Service() {
  private var mediaSession: MediaSessionCompat? = null
  private var lastTitle = "Audiobook"
  private var lastAuthor = ""
  private var lastCoverB64: String = ""
  private var lastIsPlaying = true

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    createNotificationChannel()
    mediaSession = MediaSessionCompat(this, "PiperPlaybackSession").apply {
      setFlags(MediaSessionCompat.FLAG_HANDLES_MEDIA_BUTTONS or MediaSessionCompat.FLAG_HANDLES_TRANSPORT_CONTROLS)
      setCallback(object : MediaSessionCompat.Callback() {
        override fun onPlay()     { broadcast("PLAY") }
        override fun onPause()    { broadcast("PAUSE") }
        override fun onStop()     { broadcast("STOP") }
        override fun onSkipToNext()     { broadcast("NEXT") }
        override fun onSkipToPrevious() { broadcast("PREVIOUS") }
      })
      isActive = true
    }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val action = intent?.action
    // CRITICAL: if we were spawned via startForegroundService() (API 26+),
    // Android requires us to call startForeground() within ~5 seconds OR
    // the OS will throw RemoteServiceException and kill us. So we move it
    // to the very top of the method, BEFORE any branching that could miss
    // the call (e.g. unexpected/null actions delivered after a system
    // restart of the service, or media button intents routed via the
    // MediaSession that don't carry one of our explicit actions).
    if (action != ACTION_STOP) {
      promoteToForeground()
    }
    when (action) {
      ACTION_START, ACTION_UPDATE -> {
        intent.getStringExtra(EXTRA_TITLE)?.let  { lastTitle = it }
        intent.getStringExtra(EXTRA_AUTHOR)?.let { lastAuthor = it }
        intent.getStringExtra(EXTRA_COVER)?.let  { lastCoverB64 = it }
        if (intent.hasExtra(EXTRA_PLAYING)) lastIsPlaying = intent.getBooleanExtra(EXTRA_PLAYING, true)
        // Re-emit with the freshly updated state so the lock-screen UI
        // reflects e.g. cover changes.
        promoteToForeground()
        publishMediaState()
      }
      ACTION_STOP -> {
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        mediaSession?.isActive = false
        mediaSession?.release()
        mediaSession = null
        stopSelf()
      }
      else -> MediaButtonReceiver.handleIntent(mediaSession, intent)
    }
    return START_NOT_STICKY
  }

  /**
   * Calls startForeground() with the correct signature for the running OS
   * version. On Android 14+ (API 34, UPSIDE_DOWN_CAKE) we MUST pass the
   * service type matching the manifest declaration
   * (foregroundServiceType="mediaPlayback") or the OS throws
   * MissingForegroundServiceTypeException.
   *
   * On Android 7.0-7.1.1 (API 24-25), Service.startForeground() exists but
   * does not accept a service-type argument; we call the legacy 2-arg form.
   */
  private fun promoteToForeground() {
    val notification = buildNotification()
    try {
      if (Build.VERSION.SDK_INT >= 34) {
        ServiceCompat.startForeground(
          this,
          NOTIF_ID,
          notification,
          ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK,
        )
      } else {
        startForeground(NOTIF_ID, notification)
      }
    } catch (e: Throwable) {
      // Newer Androids can deny foreground promotion when the app is
      // backgrounded for too long (ForegroundServiceStartNotAllowedException
      // on API 31+). We log + degrade gracefully \u2014 audio still plays via
      // AudioTrack, just without the lock-screen notification.
      Log.w(TAG, "promoteToForeground failed: ${e.javaClass.simpleName} ${e.message}")
    }
  }

  override fun onDestroy() {
    mediaSession?.release()
    mediaSession = null
    super.onDestroy()
  }

  // ----- Helpers -----

  private fun createNotificationChannel() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val ch = NotificationChannel(
        CHANNEL_ID,
        "Audiobook playback",
        NotificationManager.IMPORTANCE_LOW
      ).apply { description = "Lettura audiobook in corso" }
      val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
      nm.createNotificationChannel(ch)
    }
  }

  private fun decodeCover(b64: String): Bitmap? {
    if (b64.isEmpty()) return null
    return try {
      val data = if (b64.startsWith("data:")) b64.substringAfter("base64,", "") else b64
      val bytes = Base64.decode(data, Base64.DEFAULT)
      BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
    } catch (e: Throwable) {
      Log.w(TAG, "cover decode failed: ${e.message}")
      null
    }
  }

  private fun buildNotification(): Notification {
    val cover = decodeCover(lastCoverB64)

    val sessionToken = mediaSession?.sessionToken
    val style = androidx.media.app.NotificationCompat.MediaStyle()
      .setShowActionsInCompactView(0, 1, 2)
    if (sessionToken != null) style.setMediaSession(sessionToken)

    val playPauseIcon = if (lastIsPlaying) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play
    val playPauseLabel = if (lastIsPlaying) "Pausa" else "Riproduci"
    val playPausePending = MediaButtonReceiver.buildMediaButtonPendingIntent(
      this,
      if (lastIsPlaying) PlaybackStateCompat.ACTION_PAUSE else PlaybackStateCompat.ACTION_PLAY
    )
    val prev = MediaButtonReceiver.buildMediaButtonPendingIntent(this, PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS)
    val next = MediaButtonReceiver.buildMediaButtonPendingIntent(this, PlaybackStateCompat.ACTION_SKIP_TO_NEXT)

    // Tap on body opens the app.
    val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
    val launchFlags = PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
    val openPending = if (launchIntent != null)
      PendingIntent.getActivity(this, 0, launchIntent, launchFlags) else null

    val builder = NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(android.R.drawable.ic_media_play)
      .setContentTitle(lastTitle)
      .setContentText(lastAuthor.ifEmpty { "Beppe Audiobooks" })
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setOngoing(lastIsPlaying)
      .addAction(android.R.drawable.ic_media_previous, "Indietro", prev)
      .addAction(playPauseIcon, playPauseLabel, playPausePending)
      .addAction(android.R.drawable.ic_media_next, "Avanti", next)
      .setStyle(style)
    if (cover != null) builder.setLargeIcon(cover)
    if (openPending != null) builder.setContentIntent(openPending)
    return builder.build()
  }

  private fun publishMediaState() {
    val s = mediaSession ?: return
    val state = if (lastIsPlaying) PlaybackStateCompat.STATE_PLAYING else PlaybackStateCompat.STATE_PAUSED
    s.setPlaybackState(
      PlaybackStateCompat.Builder()
        .setActions(
          PlaybackStateCompat.ACTION_PLAY or PlaybackStateCompat.ACTION_PAUSE or
          PlaybackStateCompat.ACTION_PLAY_PAUSE or PlaybackStateCompat.ACTION_STOP or
          PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS or PlaybackStateCompat.ACTION_SKIP_TO_NEXT
        )
        .setState(state, 0L, 1.0f)
        .build()
    )
    val cover = decodeCover(lastCoverB64)
    val md = MediaMetadataCompat.Builder()
      .putString(MediaMetadataCompat.METADATA_KEY_TITLE, lastTitle)
      .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, lastAuthor)
    if (cover != null) md.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, cover)
    s.setMetadata(md.build())
  }

  private fun broadcast(action: String) {
    val reactContext = (application as? com.facebook.react.ReactApplication)
      ?.reactNativeHost?.reactInstanceManager?.currentReactContext ?: return
    val params = com.facebook.react.bridge.Arguments.createMap().apply {
      putString("action", "${packageName}.${action}")
    }
    PiperTtsModule.emit(reactContext as com.facebook.react.bridge.ReactApplicationContext, "piperMediaAction", params)
  }

  companion object {
    private const val TAG = "PiperPlaybackSvc"
    private const val CHANNEL_ID = "piper_playback"
    private const val NOTIF_ID = 0xB37E

    const val ACTION_START  = "com.beppeaudiobooks.pipertts.START"
    const val ACTION_UPDATE = "com.beppeaudiobooks.pipertts.UPDATE"
    const val ACTION_STOP   = "com.beppeaudiobooks.pipertts.STOP"

    const val EXTRA_TITLE   = "title"
    const val EXTRA_AUTHOR  = "author"
    const val EXTRA_COVER   = "coverBase64"
    const val EXTRA_PLAYING = "isPlaying"
  }
}
