# Actions an engineer may consider

| Situation | Action | Never |
|---|---|---|
| Fault began right after a rollout | Roll back to the previous revision | Edit configuration by hand mid-incident |
| Process alive but data stale | Restart the deployment | Restart an order gateway with working orders |
| Killed for memory | Raise the limit once, within the platform ceiling | Raise it repeatedly; that feeds a leak |
| Cannot be scheduled | Page the platform owner | Lower the pod's requests |
| Cause unknown | Page the owning team with the evidence | Guess |
