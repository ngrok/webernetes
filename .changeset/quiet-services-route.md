---
"@ngrok/webernetes": patch
---

Preserve service targets when re-registering an existing Service so endpoint reconciliation cannot briefly or permanently leave routable Services without ready targets.
