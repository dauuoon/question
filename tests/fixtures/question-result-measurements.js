globalThis.verifyQuestionResultLayout=async function() {
  const {document,location,innerWidth}=globalThis;
  if(location.hostname!=="127.0.0.1"||location.port!=="4319") {
    throw new Error("Layout verification is restricted to the synthetic loopback fixture");
  }
  const variants=await (await globalThis.fetch("/cases")).json();
  const rect=selector=>{
    const box=document.querySelector(selector).getBoundingClientRect();
    return {x:box.x,y:box.y,width:box.width,height:box.height,bottom:box.bottom};
  };
  const results=[];
  for(const variant of variants) {
    const html=await (await globalThis.fetch(`/?case=${variant.name}`)).text();
    document.body.innerHTML=new globalThis.DOMParser().parseFromString(html,"text/html").body.innerHTML;
    await document.querySelector(".question-result-image").decode();
    await new Promise(resolve=>globalThis.requestAnimationFrame(resolve));
    const left=rect(".question-image-column"),right=rect(".question-panel"),nav=rect(".question-panel-navigation");
    const frame=rect(".question-image-frame"),stage=rect(".question-image-stage");
    const image=document.querySelector(".question-result-image");
    const buttons=[...document.querySelectorAll(".question-panel-navigation button")];
    const panel=document.querySelector(".question-panel");
    const content=document.querySelector(".question-panel-content");
    const footer=document.querySelector(".question-answer-actions");
    const textarea=document.querySelector("textarea");
    results.push({name:variant.name,left,right,nav,
      imageFits:frame.width<=stage.width+1&&frame.height<=stage.height+1,
      ratioCorrect:Math.abs(frame.width/frame.height-image.naturalWidth/image.naturalHeight)<0.001,
      label:document.querySelector("textarea").getAttribute("aria-label")==="나의 생각",
      navigationFits:buttons.every(button=>{
        const box=button.getBoundingClientRect();
        const navigation=document.querySelector(".question-panel-navigation");
        return box.width>=43.9&&box.height>=43.9&&
          (navigation.scrollWidth>navigation.clientWidth||
            (box.x>=right.x&&box.right<=right.x+right.width));
      }),
      horizontalOverflow:document.documentElement.scrollWidth>innerWidth+1,
      panelFits:panel.scrollHeight<=panel.clientHeight+1&&
        content.scrollHeight<=content.clientHeight+1&&footer.scrollHeight<=footer.clientHeight+1,
      textareaScroll:textarea.scrollHeight>textarea.clientHeight+1,
      answerFits:textarea.getBoundingClientRect().bottom<=right.bottom+1,
      navGap:nav.y-right.y,
    });
  }
  const baseline=results[0];
  const failures=results.filter(result=>!result.imageFits||!result.ratioCorrect||!result.label||
    !result.navigationFits||result.horizontalOverflow||!result.panelFits||!result.answerFits||
    (result.name==="answer-long"&&!result.textareaScroll)||(innerWidth>1000&&(
      Math.abs(result.left.height-result.right.height)>0.1||
      Math.abs(result.left.y-result.right.y)>0.1||
      Math.abs(result.left.bottom-result.right.bottom)>0.1||
      (!["question-long","combined-long-failure"].includes(result.name)&&
        result.right.height<baseline.right.height-0.1)||
      Math.abs(result.nav.y-baseline.nav.y)>0.1||
      Math.abs(result.navGap-baseline.navGap)>0.1
    )));
  return {viewport:{width:innerWidth,height:globalThis.innerHeight},cases:results.length,
    cardHeightRange:[Math.min(...results.map(result=>result.right.height)),Math.max(...results.map(result=>result.right.height))],
    navigationYRange:[Math.min(...results.map(result=>result.nav.y)),Math.max(...results.map(result=>result.nav.y))],
    failures,
    panelScrollFailures:results.filter(result=>!result.panelFits).length,
    responsiveReleased:innerWidth>1000?null:results.find(result=>result.name==="question-long").right.height>baseline.right.height,
    pass:failures.length===0,
  };
};
