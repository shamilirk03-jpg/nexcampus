const r1=n=>Math.round(n*10)/10;
/** items: [{selected:number|null, correct:number}]. neg: marks deducted per wrong answer (default 0). */
export function scoreAttempt(items,neg=0){
  let correct=0,wrong=0,skipped=0;
  for(const i of items){if(i.selected==null)skipped++;else if(i.selected===i.correct)correct++;else wrong++}
  const total=items.length,attempted=correct+wrong;
  return{total,attempted,correct,wrong,skipped,
    score:Math.round((correct-wrong*neg)*100)/100,
    testPct:total?r1(correct/total*100):0,
    accuracyPct:attempted?r1(correct/attempted*100):0};
}
