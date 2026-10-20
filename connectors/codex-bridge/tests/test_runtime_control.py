import io,json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import runtime_control
class RuntimeControlTest(unittest.TestCase):
 def test_installer_acknowledgement_never_owns_activation(self):
  with tempfile.TemporaryDirectory()as d:
   config=Path(d)/'config.json';config.write_text(json.dumps({'executable':'/stable/codex'}))
   with patch('sys.argv',['runtime_control','--config',str(config),'--reconcile']),patch.object(runtime_control,'RuntimeUpdate')as controller,patch('sys.stdout',new_callable=io.StringIO)as output:
    controller.return_value.status.return_value={'codexCliActivationState':'waiting_for_idle','codexCliActivationMessage':'等待任务空闲'}
    runtime_control.main();controller.return_value.step.assert_not_called()
    self.assertEqual(json.loads(output.getvalue())['phase'],'waiting_for_idle')
 def test_activity_failure_is_busy_and_never_restarts(self):
  with tempfile.TemporaryDirectory()as d:
   config=Path(d)/'config.json';config.write_text(json.dumps({'executable':'/stable/codex'}))
   with patch('sys.argv',['runtime_control','--config',str(config),'--activity']),patch.object(runtime_control,'RuntimeUpdate')as controller,patch('sys.stdout',new_callable=io.StringIO)as output:
    controller.return_value.activity.side_effect=RuntimeError('fixture')
    runtime_control.main();self.assertTrue(json.loads(output.getvalue())['busy']);controller.return_value.step.assert_not_called()
