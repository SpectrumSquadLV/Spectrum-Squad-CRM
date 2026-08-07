// screener-admin.js -- "View Screener" button for the client record (add-on)
// ---------------------------------------------------------------------------
// Progressive-enhancement plugin, same pattern as pipeline-v2.js: it watches
// for the client detail modal opening and injects a "View Screener" button.
// Clicking it fetches that client's saved screener responses and shows them in
// a panel. Touches nothing in the core app.
// ---------------------------------------------------------------------------
(function () {
  var LABELS = {
    child_name:"Child's name", child_dob:"Date of birth", child_gender:"Gender",
    guardian_name:"Parent/guardian", contact_phone:"Phone", contact_email:"Email",
    household:"Who's at home", address:"Address", language:"Home language",
    dx_age:"Age at diagnosis", referral_reason:"Reason for referral",
    pregnancy:"Pregnancy notes", birth:"Birth notes", motor:"Motor development",
    body_movements:"Body/motor movements", sensory:"Sensory differences",
    medical_dx:"Medical diagnosis", other_dx:"Other diagnoses",
    st:"Speech therapy", st_details:"ST details", ot:"Occupational therapy", ot_details:"OT details",
    aba:"ABA services", aba_past:"Past ABA", school:"In school", school_details:"School details",
    setting:"Setting requested", availability_days:"Days available", start_time:"Start time", end_time:"End time",
    comm:"Communicates by", expressive:"Expressive language", understanding:"Understands language",
    therapist_pref:"Therapist preference",
    behavior:"Behaviors of concern", behavior_impact:"Behavior impact",
    sib:"Self-injurious behavior", sib_form:"SIB forms", sib_when:"SIB when/how often",
    motivator:"Motivators", motivator_other:"Other motivators",
    foods_eats:"Foods eaten", foods_avoids:"Foods avoided", liquids:"Liquids", feeding_help:"Feeding help",
    sleep_hours:"Sleep per night", sleep_through:"Sleeps through night", sleep_concerns:"Sleep concerns",
    toilet_trained:"Toilet trained", diaper:"Tolerates diaper changes", dressing:"Dressing",
    chores:"Chores", selfcare_ok:"Independent self-care", selfcare_behaviors:"Self-care behaviors",
    goal:"Top goals", recent_changes:"Recent changes", success_vision:"Success in 6-12 months"
  };

  function pretty(k){ return LABELS[k] || k.replace(/_/g," ").replace(/\b\w/g,function(c){return c.toUpperCase();}); }

  function currentClientId(){
    var m = (location.hash || "").match(/#\/pipeline\/(\d+)/);
    return m ? m[1] : null;
  }

  function renderPanel(payload){
    var d = payload.data || {};
    var when = payload.submitted_at ? new Date(payload.submitted_at).toLocaleString() : "";
    var rows = Object.keys(d).filter(function(k){ return k.indexOf("_")!==0; }).map(function(k){
      var v = Array.isArray(d[k]) ? d[k].join(", ") : d[k];
      if(v===undefined||v===null||String(v).trim()==="") return "";
      v = String(v).replace(/&/g,"&amp;").replace(/</g,"&lt;");
      return '<tr><td style="padding:8px 10px;border-bottom:1px solid #eee;font-weight:600;color:#1b2a6b;vertical-align:top;width:42%;">'+pretty(k)+'</td><td style="padding:8px 10px;border-bottom:1px solid #eee;">'+v+'</td></tr>';
    }).join("");
    var bd = document.createElement("div");
    bd.className = "modal-backdrop";
    bd.style.zIndex = "1000";
    bd.innerHTML =
      '<div class="modal" style="max-width:640px;">'+
        '<div class="modal-header"><div><h2>🌈 Clinical Screener</h2>'+
        (when?'<div style="color:#7a7796;font-size:13px;">Submitted '+when+'</div>':'')+
        '</div><button class="close-btn" id="scr-close">✕</button></div>'+
        '<table style="width:100%;border-collapse:collapse;font-size:14px;">'+rows+'</table>'+
      '</div>';
    document.body.appendChild(bd);
    function close(){ if(bd.parentNode) bd.parentNode.removeChild(bd); }
    bd.addEventListener("click", function(e){ if(e.target===bd) close(); });
    var c = bd.querySelector("#scr-close"); if(c) c.addEventListener("click", close);
  }

  function onClick(){
    var id = currentClientId();
    if(!id){ alert("Open a client first."); return; }
    fetch("/api/screener/submission/"+id, { credentials:"same-origin" })
      .then(function(r){ if(r.status===404) throw new Error("notdone"); if(!r.ok) throw new Error("err"); return r.json(); })
      .then(renderPanel)
      .catch(function(e){
        if(e.message==="notdone") alert("This family hasn't completed their clinical screener yet.");
        else alert("Couldn't load the screener. Please try again.");
      });
  }

  function injectInto(modal){
    if(!modal || modal.querySelector("#screener-view-btn")) return;
    if(!currentClientId()) return; // only on the client detail modal
    var header = modal.querySelector(".modal-header");
    if(!header) return;
    var btn = document.createElement("button");
    btn.id = "screener-view-btn";
    btn.type = "button";
    btn.textContent = "🌈 View Screener";
    btn.style.cssText = "font-family:inherit;font-weight:700;font-size:13px;border:none;background:#edecf8;color:#1b2a6b;padding:8px 14px;border-radius:10px;cursor:pointer;margin:0 0 14px;";
    btn.addEventListener("click", onClick);
    // place just under the header
    if(header.nextSibling) header.parentNode.insertBefore(btn, header.nextSibling);
    else header.parentNode.appendChild(btn);
  }

  var obs = new MutationObserver(function(muts){
    for(var i=0;i<muts.length;i++){
      var added = muts[i].addedNodes;
      for(var j=0;j<added.length;j++){
        var n = added[j];
        if(n.nodeType!==1) continue;
        if(n.classList && n.classList.contains("modal-backdrop")){
          var modal = n.querySelector(".modal");
          if(modal) injectInto(modal);
        }
      }
    }
  });
  obs.observe(document.body, { childList:true });
})();
