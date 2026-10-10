import test from 'node:test';
import assert from 'node:assert/strict';
import {scoreAttempt} from '../src/scoring.js';
import {weakTopics} from '../src/analytics.js';

test('scores correct, incorrect and unanswered',()=>{
  const s=scoreAttempt([{selected:1,correct:1},{selected:0,correct:1},{selected:null,correct:2},{selected:2,correct:2}]);
  assert.deepEqual([s.total,s.attempted,s.correct,s.wrong,s.skipped],[4,3,2,1,1]);
  assert.equal(s.testPct,50);assert.equal(s.accuracyPct,66.7);assert.equal(s.score,2);
});
test('zero attempted does not divide by zero',()=>{
  const s=scoreAttempt([{selected:null,correct:0},{selected:null,correct:1}]);
  assert.equal(s.accuracyPct,0);assert.equal(s.testPct,0);assert.equal(s.skipped,2);
  assert.equal(scoreAttempt([]).testPct,0);
});
test('negative marking applies only when configured',()=>{
  const items=[{selected:0,correct:0},{selected:1,correct:0}];
  assert.equal(scoreAttempt(items,0).score,1);
  assert.equal(scoreAttempt(items,0.25).score,0.75);
});
test('weak topics need minimum evidence',()=>{
  const row=c=>({category:'C',topic:'T',difficulty:'Easy',correct:c});
  const one=weakTopics([row(0)],{min:4,threshold:60});
  assert.equal(one.weak.length,0);assert.equal(one.insufficient.length,1);
  const four=weakTopics([row(0),row(0),row(1),row(0)],{min:4,threshold:60});
  assert.equal(four.weak.length,1);assert.equal(four.weak[0].accuracyPct,25);
  assert.deepEqual(four.weak[0].recommendation.practice,{category:'C',topic:'T',difficulty:'Easy'});
  assert.equal(weakTopics([row(1),row(1),row(1),row(0)],{min:4,threshold:60}).weak.length,0);
});
