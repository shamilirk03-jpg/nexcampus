const pct=(a,b)=>b?Math.round(a/b*1000)/10:0;
export const recommendedDifficulty=acc=>acc<40?'Easy':acc<70?'Medium':'Hard';
/** rows: chronological [{category,topic,difficulty,correct:0|1}] of attempted questions. Rule-based, no ML. */
export function weakTopics(rows,{min=4,threshold=60}={}){
  const m=new Map();
  for(const r of rows){
    const k=r.category+'|'+r.topic;
    let x=m.get(k);if(!x){x={category:r.category,topic:r.topic,attempts:0,correct:0,recent:[],byDifficulty:{}};m.set(k,x)}
    x.attempts++;if(r.correct)x.correct++;x.recent.push(r.correct?1:0);
    const d=(x.byDifficulty[r.difficulty]??={attempts:0,correct:0});d.attempts++;if(r.correct)d.correct++;
  }
  const weak=[],insufficient=[];
  for(const x of m.values()){
    const last=x.recent.slice(-3);
    const base={category:x.category,topic:x.topic,attempts:x.attempts,correct:x.correct,incorrect:x.attempts-x.correct,accuracyPct:pct(x.correct,x.attempts),recent:{correct:last.reduce((a,b)=>a+b,0),of:last.length},byDifficulty:x.byDifficulty};
    if(x.attempts<min){insufficient.push({...base,needed:min-x.attempts});continue}
    if(base.accuracyPct<threshold){
      const difficulty=recommendedDifficulty(base.accuracyPct),n=Math.min(8,Math.max(5,x.attempts));
      weak.push({...base,reason:`${base.correct} of ${base.attempts} correct (${base.accuracyPct}%), below the ${threshold}% threshold.`,
        recommendation:{activity:`Complete a ${n}-question ${difficulty} practice set on ${x.topic}, then review each explanation.`,difficulty,questionCount:n,practice:{category:x.category,topic:x.topic,difficulty}}});
    }
  }
  weak.sort((a,b)=>a.accuracyPct-b.accuracyPct);
  const message=!m.size?'No attempted questions yet. Complete a practice set or mock test first.':weak.length?`${weak.length} topic(s) need attention.`:insufficient.length?`No topic below ${threshold}% with enough evidence. Some topics need at least ${min} attempted questions.`:`No topic is below ${threshold}%.`;
  return{settings:{min,threshold},message,weak,insufficient};
}
