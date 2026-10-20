"""Full navigation counts stay independent of body paging and append safely."""
import json,sys,tempfile,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from bridge.features.sessions.store import SessionStore

class HistoryUserCountTests(unittest.TestCase):
    def test_hundred_inputs_append_partial_line_and_rewrite(self):
        with tempfile.TemporaryDirectory() as root:
            p=Path(root)/'history.jsonl';s=SessionStore(root)
            def row(i):return json.dumps({'type':'response_item','payload':{'type':'message','role':'user','content':[{'type':'text','text':str(i)}]}}).encode()+b'\n'
            p.write_bytes(b''.join(row(i)for i in range(100)))
            self.assertEqual(s._count_user_messages(p),100)
            offset=s.user_count_cache[str(p)]['offset']
            with p.open('ab')as f:f.write(row(100)[:-4])
            self.assertEqual(s._count_user_messages(p),100)
            self.assertEqual(s.user_count_cache[str(p)]['offset'],offset)
            with p.open('ab')as f:f.write(row(100)[-4:])
            self.assertEqual(s._count_user_messages(p),101)
            p.write_bytes(row(0));self.assertEqual(s._count_user_messages(p),1)
            p.write_bytes(row(1)+row(2)+row(3));self.assertEqual(s._count_user_messages(p),3)
    def test_tool_text_and_native_receipts_do_not_count_as_extra_inputs(self):
        with tempfile.TemporaryDirectory() as root:
            p=Path(root)/'history.jsonl';s=SessionStore(root)
            rows=[{'type':'response_item','payload':{'type':'message','role':'user','content':[]}},
                  {'type':'event_msg','payload':{'type':'item_completed','item':{'type':'UserMessage','id':'receipt'}}},
                  {'type':'response_item','payload':{'type':'custom_tool_call_output','output':'"role": "user"'}}]
            p.write_text(''.join(json.dumps(r)+'\n'for r in rows));self.assertEqual(s._count_user_messages(p),1)
    def test_literal_context_receipt_appended_later_counts_once_and_is_turn_scoped(self):
        with tempfile.TemporaryDirectory() as root:
            p=Path(root)/'history.jsonl';s=SessionStore(root)
            context='<environment_context><current_date>2026-10-19</current_date><timezone>Asia/Hong_Kong</timezone><filesystem /></environment_context>'
            def append(v):
                with p.open('a') as f:f.write(json.dumps(v)+'\n')
            append({'type':'event_msg','payload':{'type':'task_started','turn_id':'a'}})
            append({'type':'response_item','payload':{'type':'message','role':'user','content':[{'type':'input_text','text':context}]}})
            self.assertEqual(s._count_user_messages(p),0)
            receipt={'type':'event_msg','payload':{'type':'item_completed','turn_id':'a','item':{'type':'UserMessage','id':'literal'}}}
            append({**receipt,'payload':{**receipt['payload'],'turn_id':'foreign'}})
            self.assertEqual(s._count_user_messages(p),0)
            append(receipt);self.assertEqual(s._count_user_messages(p),1)
            append(receipt);self.assertEqual(s._count_user_messages(p),1)

if __name__=='__main__':unittest.main()
