# The model vendor for CoachTurnsLiveWireTests: `COACH_ANTHROPIC_BASE_URL` at this port, and each question names the round it scripts.
import json, re, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

def sse(w, event):
    w.write(("event: %s\ndata: %s\n\n" % (event["type"], json.dumps(event))).encode()); w.flush()

class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, *a): pass
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        msgs = body.get("messages")
        if msgs is None:
            self.send_response(200)
            self.send_header("content-length", "2")
            self.end_headers()
            self.wfile.write(b"{}")
            return
        first = json.dumps(msgs[0])
        m = re.search(r"wire ([a-z-]+)(?: routine=([A-Za-z0-9_.-]+))?", first)
        marker = m.group(1) if m else "plain"
        routine = m.group(2) if m else None
        rounds = sum(1 for x in msgs if x["role"] == "assistant")
        print("vendor", marker, "round", rounds, flush=True)
        blocks, stop, slow = [], "end_turn", 0
        if marker == "read-batch" and rounds == 0:
            blocks = [("text", "Checking."), ("tool", "list_routines", {}), ("tool", "list_exercises", {})]; stop = "tool_use"
        elif marker == "create-routine" and rounds == 0:
            blocks = [("tool", "create_routine", {"id": "rt_model", "name": "Wire day", "position": 0, "entries": [{"exerciseId": "bench-press"}]})]; stop = "tool_use"
        elif marker == "proposal" and rounds == 0:
            blocks = [("tool", "propose_routine_change", {"id": "pr_model", "routineId": routine, "entries": [{"exerciseId": "back-squat"}], "summary": "Squat instead"})]; stop = "tool_use"
        elif marker == "stop" and rounds == 0:
            blocks = [("text", "Thinking it over."), ("tool", "list_routines", {})]; stop = "tool_use"; slow = 2.5
        else:
            blocks = [("text", "Done, %s." % marker)]
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("connection", "close")
        self.end_headers()
        w = self.wfile
        sse(w, {"type": "message_start", "message": {"id": "msg_%d" % time.time_ns(), "type": "message", "role": "assistant", "content": [], "model": body["model"], "stop_reason": None, "usage": {"input_tokens": 40, "output_tokens": 1, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0}}})
        for i, b in enumerate(blocks):
            if b[0] == "text":
                sse(w, {"type": "content_block_start", "index": i, "content_block": {"type": "text", "text": ""}})
                sse(w, {"type": "content_block_delta", "index": i, "delta": {"type": "text_delta", "text": b[1]}})
            else:
                sse(w, {"type": "content_block_start", "index": i, "content_block": {"type": "tool_use", "id": "toolu_%d_%d" % (rounds, i), "name": b[1], "input": {}}})
                sse(w, {"type": "content_block_delta", "index": i, "delta": {"type": "input_json_delta", "partial_json": json.dumps(b[2])}})
            sse(w, {"type": "content_block_stop", "index": i})
            if slow: time.sleep(slow)
        sse(w, {"type": "message_delta", "delta": {"stop_reason": stop}, "usage": {"output_tokens": 12}})
        sse(w, {"type": "message_stop"})
        self.close_connection = True

ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
