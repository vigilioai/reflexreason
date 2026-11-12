---
id: image-pull
title: Image cannot be pulled after a rollout
symptoms: [ImagePullBackOff, ErrImagePull, InvalidImageName]
match: Image cannot be pulled: wrong tag, missing image or registry refused
action: rollout_undo
---
## Recognise
New pods of the deployment sit in ImagePullBackOff or ErrImagePull. The event text names the image and says it was not found, or that the registry refused the request. Pods of the previous revision are still serving, because the rolling update will not remove them until new pods are Ready.

## Why it happens
A release pipeline pushed a deployment that points at a tag which was never published, was typed wrongly, or lives in a registry the node cannot reach. Nothing is wrong with the running system; the new revision simply cannot start.

## Remediate
Return the deployment to its previous revision with rollout_undo. This removes the broken ReplicaSet and keeps the pods that are already serving. Do not delete pods: the old ones are the only capacity left.

## Verify
Every pod of the deployment is Running and Ready within one minute and no pod is in ImagePullBackOff.

## Escalate when
The deployment has no previous revision, or the previous revision also fails to pull. That means the registry itself is unreachable and a rollback cannot help.
