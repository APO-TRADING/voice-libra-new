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
          v3 patch (current): ULTRA-DETAILED INSTRUMENTATION on top of v2.
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