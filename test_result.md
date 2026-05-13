#====================================================================================================
# START - Testing Protocol - DO NOT EDIT OR REMOVE THIS SECTION
#====================================================================================================

# THIS SECTION CONTAINS CRITICAL TESTING INSTRUCTIONS FOR BOTH AGENTS
# BOTH MAIN_AGENT AND TESTING_AGENT MUST PRESERVE THIS ENTIRE BLOCK

# Communication Protocol:
# If the `testing_agent` is available, main agent should delegate all testing tasks to it.
#
# You have access to a file called `test_result.md`. This file contains the complete testing state
# and history, and is the primary means of communication between main and the testing agent.
#
# Main and testing agents must follow this exact format to maintain testing data. 
# The testing data must be entered in yaml format Below is the data structure:
# 
## user_problem_statement: {problem_statement}
## backend:
##   - task: "Task name"
##     implemented: true
##     working: true  # or false or "NA"
##     file: "file_path.py"
##     stuck_count: 0
##     priority: "high"  # or "medium" or "low"
##     needs_retesting: false
##     status_history:
##         -working: true  # or false or "NA"
##         -agent: "main"  # or "testing" or "user"
##         -comment: "Detailed comment about status"
##
## frontend:
##   - task: "Task name"
##     implemented: true
##     working: true  # or false or "NA"
##     file: "file_path.js"
##     stuck_count: 0
##     priority: "high"  # or "medium" or "low"
##     needs_retesting: false
##     status_history:
##         -working: true  # or false or "NA"
##         -agent: "main"  # or "testing" or "user"
##         -comment: "Detailed comment about status"
##
## metadata:
##   created_by: "main_agent"
##   version: "1.0"
##   test_sequence: 0
##   run_ui: false
##
## test_plan:
##   current_focus:
##     - "Task name 1"
##     - "Task name 2"
##   stuck_tasks:
##     - "Task name with persistent issues"
##   test_all: false
##   test_priority: "high_first"  # or "sequential" or "stuck_first"
##
## agent_communication:
##     -agent: "main"  # or "testing" or "user"
##     -message: "Communication message between agents"

# Protocol Guidelines for Main agent
#
# 1. Update Test Result File Before Testing:
#    - Main agent must always update the `test_result.md` file before calling the testing agent
#    - Add implementation details to the status_history
#    - Set `needs_retesting` to true for tasks that need testing
#    - Update the `test_plan` section to guide testing priorities
#    - Add a message to `agent_communication` explaining what you've done
#
# 2. Incorporate User Feedback:
#    - When a user provides feedback that something is or isn't working, add this information to the relevant task's status_history
#    - Update the working status based on user feedback
#    - If a user reports an issue with a task that was marked as working, increment the stuck_count
#    - Whenever user reports issue in the app, if we have testing agent and task_result.md file so find the appropriate task for that and append in status_history of that task to contain the user concern and problem as well 
#
# 3. Track Stuck Tasks:
#    - Monitor which tasks have high stuck_count values or where you are fixing same issue again and again, analyze that when you read task_result.md
#    - For persistent issues, use websearch tool to find solutions
#    - Pay special attention to tasks in the stuck_tasks list
#    - When you fix an issue with a stuck task, don't reset the stuck_count until the testing agent confirms it's working
#
# 4. Provide Context to Testing Agent:
#    - When calling the testing agent, provide clear instructions about:
#      - Which tasks need testing (reference the test_plan)
#      - Any authentication details or configuration needed
#      - Specific test scenarios to focus on
#      - Any known issues or edge cases to verify
#
# 5. Call the testing agent with specific instructions referring to test_result.md
#
# IMPORTANT: Main agent must ALWAYS update test_result.md BEFORE calling the testing agent, as it relies on this file to understand what to test next.

#====================================================================================================
# END - Testing Protocol - DO NOT EDIT OR REMOVE THIS SECTION
#====================================================================================================



#====================================================================================================
# Testing Data - Main Agent and testing sub agent both should log testing data below this section
#====================================================================================================

user_problem_statement: |
  Audiolibri mobile offline app powered by Piper TTS (sherpa-onnx), Italian.
  Persistent SIGSEGV crash during sherpa-onnx OfflineTts inference with a custom
  beppe.onnx Italian Piper model. App architecture is 100% offline (no backend).

frontend:
  - task: "Piper TTS native engine (sherpa-onnx) SIGSEGV crash"
    implemented: true
    working: "NA"  # awaiting user EAS build + device test
    file: "frontend/patches/react-native-sherpa-onnx-offline-tts+0.2.6.patch"
    stuck_count: 3
    priority: "high"
    needs_retesting: true
    status_history:
      - working: false
        agent: "main"
        comment: |
          Initial issue: SIGSEGV during OfflineTts inference. App crashed before
          producing any audio. Bundled AAR was 1.10.35 (Oct 2023) — incompatible
          with PyTorch 2.1+ Piper models.
      - working: false
        agent: "main"
        comment: |
          First patch attempt: upgraded JitPack AAR to 1.12.15, switched
          AudioTrack ENCODING_PCM_FLOAT → PCM_16BIT, bypassed splitText, added
          OfflineTtsConfig with noiseScale 0.667, noiseScaleW 0.8 (vanilla).
          User reported still SIGSEGV on first generate() — init-sherpa OK but
          crash on "Ciao." playback.
      - working: "NA"
        agent: "main"
        comment: |
          v4 patch (current) — CRITICAL FIX after user provided trace from
          108MB Piper "high" Italian model crash on Realme RMX5070:

          ROOT CAUSE IDENTIFIED from trace:
          1) The original initializeTTS @ReactMethod did NOT take a Promise,
             so RN bridge fire-and-forget meant JS continued after only 37ms
             (fixed 50ms setTimeout). Native was still in init.5d.OfflineTts.new
             loading the 108MB model. JS then called speak("Ciao.") which
             SIGSEGV'd the engine in a half-initialized state.
          2) SIGSEGV is NOT a catchable Java exception. The xnnpack-first
             provider order meant xnnpack crashed the WHOLE PROCESS, so the
             CPU fallback never ran.

          v4 FIXES applied:
          (a) Added @ReactMethod overload `initializeTTS(sr, ch, modelId,
              promise: Promise)` that runs full init on background Thread and
              resolves the promise ONLY after init.8.DONE. JS now uses
              `await new Promise(...)` with 10-minute safety timeout.
          (b) REVERSED provider order: ["cpu", "xnnpack"]. CPU is the
              reference implementation in onnxruntime, handles ALL ops, just
              slower. Eliminates the unrecoverable xnnpack SIGSEGV.
          (c) Adaptive numThreads: for models > 80MB (Piper "high"), capped
              to 2 threads. Reduces peak memory pressure during model load.
          (d) JS phase6 trace now shows phase6.native.resolve/reject AT THE
              ACTUAL completion (not 37ms later).
          (e) Kept legacy `initializeTTSLegacy(sr, ch, modelId)` for backward
              compat.

          Total patch v4: 701 lines, 3 files modified. Promise-based init,
          CPU-first provider, model-size-aware threads, granular trace 89+.
          v4 confirmed by user: TTS initializes correctly and plays the first
          sentence cleanly with the riccardo-x_low 16kHz model. PROBLEM
          REMAINING: playback stops after exactly 2 sentences and then on
          replay the device's stock TTS speaks instead of Piper.
      - working: "NA"
        agent: "main"
        comment: |
          v5 patch (current) — RACE CONDITION FIX for "stops after 2 sentences":

          ROOT CAUSE ANALYSIS (from user-supplied trace):
            speak.start emitted at T+0ms, audio reasonably long (~400ms)
            speak.end resolves at T+1ms — WAY too early.
          The premature speak.end caused the JS playLoop to immediately call
          generateAndPlay() for the next sentence, which invokes
          beginPlayback() → audioQueue.clear() + pendingWrites=0 reset.
          The playback thread was still mid-write on the previous sentence's
          tail samples, so the AudioTrack ring buffer underran. After 2-3
          sentences the engine entered a half-stuck state, the next
          piperSpeak() rejected, and JS-side `setEngine('device')` permanently
          demoted the engine.

          A SECOND independent bug: piperEngine.stopSpeak() was calling
          tts.deinitialize() — which RELEASES the entire sherpa-onnx OfflineTts
          instance and the AudioTrack. The follow-up initEngine() runs in the
          background, but a concurrent play() finds ready=false and the
          speakOne() path falls through to expo-speech (the device's stock TTS).
          This is why the user reported "when I press play again, the device's
          voice speaks, not Piper".

          v5 FIXES applied (3 files modified, patch grew 701 → 1050 lines):

          (A) AudioPlayer.kt — proper completion detection
              • pendingChunks / pendingWrites are now AtomicInteger (was
                @Volatile var with non-atomic ++/-- — itself a race).
              • Track totalFramesWritten cumulatively in the playback thread.
              • maybeSendCompletion() no longer fires didUpdateVolume(-1f)
                immediately when the queue is empty. Instead it posts a
                checkDrainAndFinish() runnable to the main thread that
                compares AudioTrack.getPlaybackHeadPosition() against
                totalFramesWritten. The -1f signal is only emitted once the
                playback head catches up (i.e. the user has actually heard
                every written frame). Has a 5s deadline cap as safety.
              • Bumped intended buffer 20ms → 200ms so AudioTrack tolerates
                short stalls in the playback thread without underrunning.
              • New stopPlayback() — soft stop that pauses + flushes the
                AudioTrack and clears counters but PRESERVES the engine.
              • beginPlayback() now also flushes the AudioTrack so
                getPlaybackHeadPosition() restarts at 0 in sync with
                totalFramesWritten = 0.

          (B) TTSManagerModule.kt — new @ReactMethod
              • @ReactMethod stopPlayback(promise) → calls
                AudioPlayer.stopPlayback() and resolves the in-flight
                pendingPromise as "Playback interrupted". Engine + AudioTrack
                remain alive.
              • @ReactMethod isReady(promise) → lightweight probe used by JS
                diagnostics screen.
              • deinitialize() unchanged (still available for full teardown).

          (C) piperEngine.ts — stopSpeak() uses stopPlayback
              • stopSpeak() now calls NativeModules.TTSManager.stopPlayback()
                instead of tts.deinitialize(). Crucially, it does NOT clear
                ready / initPromise. The next speakSentence() resumes
                instantly with Piper.
              • Legacy fallback retained for old patches without
                stopPlayback.

          (D) PlayerContext.tsx — resilient fallback
              • piperFailCountRef (max 3 consecutive errors before flipping
                the UI engine label to 'device'). A single transient error
                no longer demotes the engine.
              • On success after failures, the counter resets AND the engine
                label is promoted back to 'piper'.
              • play() resets the counter and re-inits Piper if ready=false.

          Awaiting user rebuild + new trace (eas build --platform android).
          Expected behavior:
            - "speak.end" timestamps should now match approximate sentence
              durations (e.g. 1-3s, not 1ms).
            - Continuous reading of an arbitrary number of sentences without
              fallback to device TTS.
            - Pause/resume preserves the Piper engine (no re-init delay).

          v4 FIXES applied:
          (a) Added @ReactMethod overload `initializeTTS(sr, ch, modelId,
              promise: Promise)` that runs full init on background Thread and
              resolves the promise ONLY after init.8.DONE. JS now uses
              `await new Promise(...)` with 10-minute safety timeout.
          (b) REVERSED provider order: ["cpu", "xnnpack"]. CPU is the
              reference implementation in onnxruntime, handles ALL ops, just
              slower. Eliminates the unrecoverable xnnpack SIGSEGV.
          (c) Adaptive numThreads: for models > 80MB (Piper "high"), capped
              to 2 threads. Reduces peak memory pressure during model load.
          (d) JS phase6 trace now shows phase6.native.resolve/reject AT THE
              ACTUAL completion (not 37ms later).
          (e) Kept legacy `initializeTTSLegacy(sr, ch, modelId)` for backward
              compat.

          Total patch v4: 701 lines, 3 files modified. Promise-based init,
          CPU-first provider, model-size-aware threads, granular trace 89+.
          Awaiting user rebuild + new trace.
          Every single sub-step of TTS init is now logged with a unique
          [native]/[audio] tag visible in the Diagnostics panel. If the JNI
          crashes, the user can pinpoint EXACTLY which Kotlin line died.
          Specific instrumentation added:
          - init.0.enter, init.0a.sysinfo (ABI, SDK, model, memory)
          - init.1.audioplayer.new(.ok|.THREW)
          - init.2.json.parse(.ok|.THREW)
          - init.3a.model.check (exists/readable/size/ONNX magic bytes hex)
          - init.3b.tokens.check (exists/readable/size/firstLine)
          - init.3c.espeak.check (entries count, phontab/phonindex presence)
          - init.4.threads (CPU cores -> optimal thread count)
          - init.5.provider per provider with sub-steps:
            * init.5a.vits.build (.ok)
            * init.5b.model.build (.ok)
            * init.5c.tts.build (.ok)
            * init.5d.OfflineTts.new (.ok | .THREW with stack trace)
            * init.5e.tts.sampleRate (.ok)
            * init.5f.tts.numSpeakers (.ok)
            * init.5g.sanity generate("Hello") (.ok with samples + sr + ms)
            * init.5h.ACCEPT/REJECT
          - init.7.audioplayer.start (.ok | .THREW)
          - init.8.DONE with total elapsed ms
          - [audio] start.enter/config/buffer/builder/play/play.ok
          - [audio] playback.thread.enter/chunk.take/chunk.write
          - JS side adds matching [js] sysinfo dump, ==PHASE.N== markers,
            espeak.read.b64/decode/unzip progress, ONNX magic bytes check.
          - New runFullDiagnostics() exported function for Settings panel:
            performs 10 file-integrity checks (Platform, Device, NativeModule,
            DestDir, Model, OnnxMagic, Tokens, EspeakDir, EspeakFiles,
            TraceFile, EngineState) WITHOUT triggering native TTS init —
            useful to confirm asset extraction before risking a crash.
          - Settings UI shows colored ✓/✗ indicator per diagnostic step.
          Total: 89 trace points in native patch, 49 init.N.* steps.
          Patch file: 640 lines, 3 files modified.

metadata:
  created_by: "main_agent"
  version: "2.0"
  test_sequence: 0
  run_ui: false

test_plan:
  current_focus:
    - "Piper TTS native engine (sherpa-onnx) SIGSEGV crash"
  stuck_tasks:
    - "Piper TTS native engine (sherpa-onnx) SIGSEGV crash"
  test_all: false
  test_priority: "stuck_first"

agent_communication:
  - agent: "main"
    message: |
      Patch v2 applied. JitPack 1.12.15 → 1.12.26, xnnpack→cpu provider
      fallback, VoxSherpa "calmed" VITS defaults. Native testing requires
      EAS build + physical Android device — cannot be tested by automated
      agents. User to rebuild APK and share DIAGNOSTICA PIPER trace.
  - agent: "main"
    message: |
      v5 patch applied (race condition fix). 4 files modified:
      - patches/react-native-sherpa-onnx-offline-tts+0.2.6.patch (701→1050L)
      - src/audio/piperEngine.ts (stopSpeak now uses native stopPlayback)
      - src/contexts/PlayerContext.tsx (resilient fallback w/ piperFailCount)
      USER ACTION REQUIRED: rebuild via `eas build --platform android --profile preview`
      and verify continuous reading of >2 sentences. Check the
      "DIAGNOSTICA PIPER" trace for [audio] completion.signal / drained
      markers and ensure speak.end timestamps now match audio durations
      (1-3s for typical sentences, not 1ms).
  - agent: "main"
    message: |
      v6 — Library UX improvements (sorting + author + navigable folders).
      No native code changes; pure JS/RN UI work. Files:
      - src/storage/library.ts (added `author`, `sort_order`, `SortMode`,
        listBooksSorted, getSortMode/setSortMode, reorderBooks, getFolder,
        backwards-compatible normalize() for old books)
      - src/api/client.ts (exposed the new methods)
      - src/components/BookList.tsx (NEW reusable component: grid/list,
        4 sort modes via chips, long-press action sheet with Edit/Delete,
        manual reorder with ↑/↓ buttons)
      - src/components/BookEditModal.tsx (NEW: edit title/author/cover/folder)
      - app/(tabs)/index.tsx (uses BookList)
      - app/folders/[id].tsx (NEW: folder detail screen, route /folders/<id>
        or /folders/none for un-filed)
      - app/(tabs)/folders.tsx (folder rows are now navigable; pencil/trash
        buttons stopPropagation())
      - app/(tabs)/upload.tsx (added AUTORE TextInput)
      - app/_layout.tsx (registered folders/[id] route)
      Tested via tsc --noEmit and metro bundling, no errors.