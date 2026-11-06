"""GET event channels observe standalone sessions without attaching writers."""
import io
import threading
import unittest
from types import SimpleNamespace

from bridge.api.httpd import Handler


THREAD = '01901234-5678-7000-8000-000000000001'


class ReadSession:
    def __init__(self):
        self.condition = threading.Condition(threading.RLock())
        self.sequence = 7
        self.timeline = SimpleNamespace(epoch='current-epoch')
        self.viewers = 0
        self.touched = 0


class EventReadObservationTests(unittest.TestCase):
    def handler(self):
        handler = Handler.__new__(Handler)
        handler.authorized = lambda *args, **kwargs: False
        outputs = []
        handler.output = lambda *args, **kwargs: outputs.append((args, kwargs))
        handler.wfile = io.BytesIO()
        responses, headers = [], []
        handler.send_response = responses.append
        handler.send_header = lambda *args: headers.append(args)
        handler.headers_common = lambda *args: None
        handler.end_headers = lambda: None
        return handler, outputs, responses, headers

    def bridge(self, *, standalone, closed=False):
        session = ReadSession()
        bridge = SimpleNamespace(standalone=standalone, closed=threading.Event(), session_obj=session,
                                 view=lambda *_args, **_kwargs: self.fail('unauthorized read emitted a state body'),
                                 timeline_read=lambda *_args, **_kwargs: self.fail('unauthorized read emitted changes'))
        if closed:
            bridge.closed.set()
        calls = []
        if standalone:
            def read_session(thread_id, background=False, attach=None):
                calls.append((thread_id, background, attach))
                if attach is not False:
                    raise AssertionError('standalone GET channel attempted an attached session')
                return session
        else:
            def read_session(thread_id, background=False):
                calls.append((thread_id, background))
                return session
        bridge.session = read_session
        return bridge, session, calls

    def exercise(self, method):
        for standalone in (True, False):
            with self.subTest(method=method, standalone=standalone):
                handler, outputs, responses, headers = self.handler()
                bridge, session, calls = self.bridge(standalone=standalone, closed=(method == 'stream'))

                if method == 'poll':
                    handler.poll(bridge, THREAD, after=6)
                elif method == 'changes':
                    handler.changes(bridge, THREAD, after=7, epoch='old-epoch', start=0)
                else:
                    handler.stream(bridge, THREAD)

                expected = [(THREAD, True, False)] if standalone else [(THREAD, True)]
                self.assertEqual(calls, expected)
                self.assertEqual(session.viewers, 0)
                self.assertGreater(session.touched, 0)
                self.assertEqual(outputs, [])
                if method == 'stream':
                    self.assertEqual(responses, [200])
                    self.assertTrue(any(row[0] == 'Content-Type' and row[1].startswith('text/event-stream')
                                        for row in headers))
                    self.assertEqual(handler.wfile.getvalue(), b'')

    def test_poll_uses_read_only_standalone_session_and_legacy_signature(self):
        self.exercise('poll')

    def test_changes_uses_read_only_standalone_session_and_legacy_signature(self):
        self.exercise('changes')

    def test_stream_uses_read_only_standalone_session_and_legacy_signature(self):
        self.exercise('stream')


if __name__ == '__main__':
    unittest.main()
