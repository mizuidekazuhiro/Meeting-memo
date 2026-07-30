from __future__ import annotations

import main
from retaining_transcription_service import RetainingTranscriptionService

# Keep the existing API/routes/job-state implementation and replace only the
# transcription service used by background jobs.
main.service = RetainingTranscriptionService()
app = main.app
