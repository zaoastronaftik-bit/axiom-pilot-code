import json
import tempfile
import unittest
from pathlib import Path
from validate import validate

class ValidationTests(unittest.TestCase):
    def fixtures(self, train, evaluation):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        paths = [Path(temp.name)/'train.jsonl', Path(temp.name)/'eval.jsonl']
        for path, row in zip(paths, [train,evaluation]):
            path.write_text(json.dumps(row)+'\n')
        return paths
    def row(self, split, prompt):
        return {'schema':1,'id':split,'split':split,'license':'MIT','source':'authored-test-fixture','consent':True,'messages':[{'role':'user','content':prompt},{'role':'assistant','content':'Response'}]}
    def test_disjoint(self):
        a,b=self.fixtures(self.row('train','Explain file permission boundaries'),self.row('eval','Return a structured tool error'))
        self.assertEqual([len(x) for x in validate(a,b)],[1,1])
    def test_leakage(self):
        a,b=self.fixtures(self.row('train','Same task'),self.row('eval','Same task'))
        with self.assertRaises(ValueError): validate(a,b)
    def test_unlicensed(self):
        row=self.row('train','A');row['license']='unknown'
        a,b=self.fixtures(row,self.row('eval','B'))
        with self.assertRaises(ValueError): validate(a,b)
    def test_pii(self):
        a,b=self.fixtures(self.row('train','Email person@example.com'),self.row('eval','B'))
        with self.assertRaises(ValueError): validate(a,b)
    def test_orphan_tool(self):
        row=self.row('train','A');row['messages'].append({'role':'tool','tool_call_id':'missing','content':'x'})
        a,b=self.fixtures(row,self.row('eval','B'))
        with self.assertRaises(ValueError): validate(a,b)

if __name__=='__main__': unittest.main()
