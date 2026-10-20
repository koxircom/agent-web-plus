"""Details reuse an unchanged native timeline, and invalidate on native events."""
import tempfile
import unittest
import test_history_prefix_growth as fixtures
ID=fixtures.ID
class DetailCacheTests(unittest.TestCase):
    def test_long_reply_chunks_reuse_projection_and_preserve_text(self):
        with tempfile.TemporaryDirectory() as root:
            bridge,chat,_=fixtures.PrefixGrowthTests().make(root,4)
            text='完整历史正文'*10000;chat.state['turns'][-1]['items'][-1]['text']=text
            calls=[];view=chat.view
            def counted(**kwargs):calls.append(1);return view(**kwargs)
            chat.view=counted
            page=bridge.timeline_read(ID,limit=1000);row=page['rows'][-1];cursor=chat.timeline.cursor(row['key'])
            offset=0;pieces=[]
            while True:
                detail=bridge.timeline_read(ID,mode='detail',cursor=cursor,offset=offset,version=row['version'])
                pieces.append(detail['text'])
                if detail['next'] is None:break
                offset=detail['next']
            self.assertEqual(''.join(pieces),text);self.assertEqual(len(calls),1)
    def test_native_change_invalidates_and_returns_new_version_from_start(self):
        with tempfile.TemporaryDirectory() as root:
            bridge,chat,_=fixtures.PrefixGrowthTests().make(root,4)
            page=bridge.timeline_read(ID,limit=1000);row=page['rows'][-1];cursor=chat.timeline.cursor(row['key'])
            chat.state['turns'][-1]['items'][-1]['text']='更新后的正文'
            with chat.condition:chat.changed()
            detail=bridge.timeline_read(ID,mode='detail',cursor=cursor,offset=16000,version=row['version'])
            self.assertEqual(detail['text'],'更新后的正文');self.assertEqual(detail['offset'],0);self.assertNotEqual(detail['version'],row['version'])
    def test_unknown_cursor_stays_rejected_when_projection_cached(self):
        with tempfile.TemporaryDirectory() as root:
            bridge,chat,_=fixtures.PrefixGrowthTests().make(root,4);bridge.timeline_read(ID)
            with self.assertRaisesRegex(ValueError,'内容已更新'):bridge.timeline_read(ID,mode='detail',cursor='unknown')
