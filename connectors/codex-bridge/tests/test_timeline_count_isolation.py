"""Slow persisted turn counts must not block live state or events."""
import tempfile
import threading
import unittest
from types import SimpleNamespace

from test_shared_bridge import ID, SharedBridgeTests


class TimelineCountIsolationTests(unittest.TestCase):
    def test_slow_count_does_not_block_state_or_native_event(self):
        with tempfile.TemporaryDirectory() as root:
            bridge, chat, _ = SharedBridgeTests().fixture(root)
            entered, release, state_done, event_done = (threading.Event() for _ in range(4))
            errors, pages, states = [], [], []

            def count(_thread):
                entered.set()
                if not release.wait(3):
                    raise AssertionError('count was not released')
                return 17

            bridge.history = SimpleNamespace(user_message_count=count)
            bridge._native_queue_items = lambda _: []
            bridge.session = lambda *_args, **_kwargs: chat
            bridge._annotate_upload_attachments = lambda *_args: None

            def run(fn, done=None):
                try:
                    fn()
                except BaseException as error:
                    errors.append(error)
                finally:
                    if done:
                        done.set()

            workers = [
                threading.Thread(target=run, args=(lambda: pages.append(bridge.timeline_read(ID)),)),
                threading.Thread(target=run, args=(lambda: states.append(bridge.view(ID, metadata=True)), state_done)),
                threading.Thread(target=run, args=(lambda: chat._event({'method': 'thread/status/changed',
                    'params': {'threadId': ID, 'status': {'type': 'active'}}}), event_done)),
            ]
            workers[0].start()
            try:
                self.assertTrue(entered.wait(1))
                for worker in workers[1:]:
                    worker.start()
                self.assertTrue(state_done.wait(0.5), 'state read waited for persisted count')
                self.assertTrue(event_done.wait(0.5), 'native event waited for persisted count')
            finally:
                release.set()
                for worker in workers:
                    if worker.ident is not None:
                        worker.join(2)
            self.assertFalse(errors, errors)
            self.assertTrue(states)
            self.assertEqual(pages[0]['meta']['userMessageCount'], 17)


if __name__ == '__main__':
    unittest.main()
