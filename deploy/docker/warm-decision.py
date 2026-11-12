"""Build-time step of decision.Dockerfile: ask the server one real question.

The decision server answers /health long before it has loaded, or even
downloaded, its weights; they arrive with the first decision. Asking one
here is what puts the weights into the image. If no answer comes, the build
fails, which is better than an image that looks fine and cannot decide.
"""

import json
import sys
import time
import urllib.request

URL = "http://127.0.0.1:8100/v1/systemone"
BODY = json.dumps(
    {
        "state": "ready?",
        "questions": {"ok": {"type": "noul", "instructions": "Is this text?"}},
    }
).encode()

deadline = time.time() + 30 * 60
while time.time() < deadline:
    try:
        request = urllib.request.Request(
            URL, BODY, {"content-type": "application/json"}
        )
        with urllib.request.urlopen(request, timeout=600) as reply:
            if reply.status == 200:
                print("decision server answered:", reply.read()[:120])
                sys.exit(0)
    except OSError as error:
        print("waiting:", error)
    time.sleep(5)
sys.exit("the decision server never answered a question")
