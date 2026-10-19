import unittest
from calculate import add

class CalculateTests(unittest.TestCase):
    def test_sum(self):
        self.assertEqual(add(2, 3), 5)
