import tempfile,threading,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from bridge.clients.codex.standalone import StandaloneBridge

class CliVersionTest(unittest.TestCase):
    def bridge(self, path):
        b=StandaloneBridge.__new__(StandaloneBridge)
        b.executable=str(path);b.cli_version_lock=threading.Lock();b.cli_version_cache=None
        return b
    def test_exact_executor_cached_and_bounded(self):
        with tempfile.TemporaryDirectory() as d:
            executable=Path(d)/'codex';executable.write_text('fixture')
            b=self.bridge(executable)
            with patch('bridge.clients.codex.standalone.subprocess.run',return_value=SimpleNamespace(stdout='codex-cli 0.162.1\n')) as run:
                self.assertEqual(b.cli_version()['codexCliInstalledVersion'],'0.162.1')
                self.assertIsNone(b.cli_version()['codexCliRunningVersion'])
                self.assertEqual(run.call_count,1)
                self.assertEqual(run.call_args.args[0],[str(executable),'--version'])
                self.assertEqual(run.call_args.kwargs['timeout'],3)
    def test_invalid_output_is_unknown_never_pi_version(self):
        with tempfile.TemporaryDirectory() as d:
            executable=Path(d)/'codex';executable.write_text('fixture')
            with patch('bridge.clients.codex.standalone.subprocess.run',return_value=SimpleNamespace(stdout='pi 1.3.0')):
                self.assertIsNone(self.bridge(executable).cli_version()['codexCliVersion'])
