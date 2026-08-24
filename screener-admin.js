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

  // The client card carries its own id (data-client-id). The hash is the
  // fallback, because the card is only reachable by URL from the pipeline
  // board -- everywhere else opens it directly.
  function clientIdOf(modal){
    if (modal) {
      var el = modal.closest ? modal.closest("[data-client-id]") : null;
      if (el && el.getAttribute("data-client-id")) return el.getAttribute("data-client-id");
      var inner = modal.querySelector ? modal.querySelector("[data-client-id]") : null;
      if (inner && inner.getAttribute("data-client-id")) return inner.getAttribute("data-client-id");
    }
    var m = (location.hash || "").match(/#\/pipeline\/(\d+)/);
    return m ? m[1] : null;
  }
  function currentClientId(){ return clientIdOf(null); }

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

  function onClick(ev){
    var id = clientIdOf(ev && ev.target);
    if(!id){ alert("Open a client first."); return; }
    fetch("/api/screener/submission/"+id, { credentials:"same-origin" })
      .then(function(r){ if(r.status===404) throw new Error("notdone"); if(!r.ok) throw new Error("err"); return r.json(); })
      .then(renderPanel)
      .catch(function(e){
        if(e.message==="notdone") alert("This family hasn't completed their clinical screener yet.");
        else alert("Couldn't load the screener. Please try again.");
      });
  }

  // ---- Manual send -------------------------------------------------------
  // The screener normally goes out by itself once the SignNow enrollment
  // packet comes back signed. When that never happens -- a stalled packet, a
  // family who signed on paper, a bounced address -- this is the way to send
  // the SAME screener by hand. It reuses the client's existing invite token,
  // so a family never gets two different links, and it records the send so the
  // strip below can say when it last went out and who sent it.
  function esc(s){ return String(s==null?"":s).replace(/[&<>"]/g, function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]; }); }
  function when(s){ if(!s) return ""; try { return new Date(s).toLocaleString(); } catch(e){ return s; } }

  function getJson(url, opts){
    opts = opts || {};
    return fetch(url, {
      method: opts.method || "GET",
      credentials: "same-origin",
      headers: opts.body ? { "Content-Type": "application/json" } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function(r){
      return r.json().catch(function(){ return {}; }).then(function(d){
        if(!r.ok) { var e = new Error(d.error || "Request failed"); e.status = r.status; e.code = d.code; throw e; }
        return d;
      });
    });
  }

  function renderStrip(strip, st){
    if(!st){ strip.innerHTML = ""; return; }
    var bits = [];
    if(st.completed){
      bits.push('<span style="background:#dcfce7;color:#166534;font-weight:700;padding:2px 9px;border-radius:20px;">✓ Screener completed</span>');
    } else if(st.last_sent_at){
      bits.push('<span style="background:#e7effb;color:#1b3a7b;font-weight:700;padding:2px 9px;border-radius:20px;">Sent ' + esc(when(st.last_sent_at)) + '</span>');
    } else {
      bits.push('<span style="background:#fef3c7;color:#92400e;font-weight:700;padding:2px 9px;border-radius:20px;">Not sent yet</span>');
    }
    if(st.last_manual_sent_at){
      bits.push('<span style="color:#7a7796;">Last sent by hand by ' + esc(st.last_manual_sent_by || "staff") + ' &middot; ' + esc(when(st.last_manual_sent_at)) + (st.manual_send_count > 1 ? " (" + st.manual_send_count + " manual sends)" : "") + '</span>');
    }
    if(st.reminder_count){
      bits.push('<span style="color:#7a7796;">' + st.reminder_count + ' automatic reminder' + (st.reminder_count === 1 ? "" : "s") + '</span>');
    }
    if(st.auto_blocked_reason){
      bits.push('<span style="color:#946213;">⚠ ' + esc(st.auto_blocked_reason) + '</span>');
    }
    strip.innerHTML = bits.join(' <span style="color:#d6d3e6;">|</span> ');
  }

  function wireSend(sendBtn, strip, id){
    var busy = false;
    function refresh(){
      return getJson("/api/screener/status/" + id)
        .then(function(st){
          renderStrip(strip, st);
          sendBtn.textContent = st.completed ? "📨 Send Screener again"
            : (st.last_sent_at ? "📨 Resend Screener" : "📨 Send Screener");
          sendBtn.disabled = !st.has_parent_email;
          sendBtn.title = st.has_parent_email
            ? "Email the clinical screener to " + (st.parent_email || "the parent/guardian")
            : "No parent email on file for this family.";
          return st;
        })
        .catch(function(){ strip.innerHTML = ""; });
    }
    function send(force){
      busy = true; sendBtn.disabled = true;
      var was = sendBtn.textContent;
      sendBtn.textContent = "Sending…";
      return getJson("/api/screener/send/" + id, { method: "POST", body: { force: !!force } })
        .then(function(r){
          strip.innerHTML = '<span style="background:#dcfce7;color:#166534;font-weight:700;padding:2px 9px;border-radius:20px;">✓ Screener sent to ' + esc(r.sent_to) + '</span>';
          busy = false;
          setTimeout(refresh, 1200);
        })
        .catch(function(e){
          busy = false; sendBtn.disabled = false; sendBtn.textContent = was;
          // 409 = the accident guard (already completed, or sent very
          // recently). Ask, then let a deliberate resend through.
          if(e.status === 409 && !force){
            if(confirm(e.message)) return send(true);
            return;
          }
          alert(e.message || "Could not send the screener.");
        });
    }
    sendBtn.addEventListener("click", function(){ if(!busy) send(false); });
    refresh();
  }

  function injectInto(modal){
    if(!modal || modal.querySelector("#screener-view-btn")) return;
    // Strictly the client card: the id has to come from the card's own markup,
    // not from the hash. Otherwise any dialog opened while a client URL is in
    // the address bar (the "reason" prompt, the screener panel itself) would
    // pick up a Send Screener button of its own.
    var id = modal.getAttribute && modal.getAttribute("data-client-id");
    if(!id) return;
    var header = modal.querySelector(".modal-header");
    if(!header) return;

    var bar = document.createElement("div");
    bar.id = "screener-bar";
    bar.style.cssText = "display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:0 0 14px;";

    var btn = document.createElement("button");
    btn.id = "screener-view-btn";
    btn.type = "button";
    btn.textContent = "🌈 View Screener";
    btn.style.cssText = "font-family:inherit;font-weight:700;font-size:13px;border:none;background:#edecf8;color:#1b2a6b;padding:8px 14px;border-radius:10px;cursor:pointer;";
    btn.addEventListener("click", onClick);
    bar.appendChild(btn);

    var sendBtn = document.createElement("button");
    sendBtn.id = "screener-send-btn";
    sendBtn.type = "button";
    sendBtn.textContent = "📨 Send Screener";
    sendBtn.style.cssText = "font-family:inherit;font-weight:700;font-size:13px;border:none;background:#1b2a6b;color:#fff;padding:8px 14px;border-radius:10px;cursor:pointer;";
    bar.appendChild(sendBtn);

    // "Already done" -- for a family who completed the screener on paper, over
    // the phone, or before the CRM existed. It stops the automatic invite and
    // the daily reminders, which is the point: chasing somebody for a form they
    // have already filled in is the worst message in the chain.
    var pdfBtn = document.createElement("button");
    pdfBtn.id = "screener-pdf-btn";
    pdfBtn.type = "button";
    pdfBtn.textContent = "⬇ Download PDF";
    pdfBtn.title = "The screener as a document, with every question the parent was asked and their answer under it.";
    pdfBtn.style.cssText = "font-family:inherit;font-weight:700;font-size:13px;border:none;background:#edecf8;color:#1b2a6b;padding:8px 14px;border-radius:10px;cursor:pointer;";
    pdfBtn.addEventListener("click", function(){
      // A plain navigation, so the browser handles the download and a 404
      // ("not completed yet") is shown by the server rather than swallowed.
      window.open("/api/screener/pdf/" + id, "_blank");
    });
    bar.appendChild(pdfBtn);

    var doneBtn = document.createElement("button");
    doneBtn.id = "screener-done-btn";
    doneBtn.type = "button";
    doneBtn.textContent = "✓ Already done";
    doneBtn.title = "Record the screener as already completed. Nothing is emailed to the family, and the reminders stop.";
    doneBtn.style.cssText = "font-family:inherit;font-weight:700;font-size:13px;border:none;background:#eef0f4;color:#3b4252;padding:8px 14px;border-radius:10px;cursor:pointer;";
    bar.appendChild(doneBtn);

    var strip = document.createElement("div");
    strip.id = "screener-status-strip";
    strip.style.cssText = "flex-basis:100%;font-size:12px;color:#5b5876;display:flex;flex-wrap:wrap;gap:8px;align-items:center;";
    bar.appendChild(strip);

    // place just under the header
    if(header.nextSibling) header.parentNode.insertBefore(bar, header.nextSibling);
    else header.parentNode.appendChild(bar);

    wireSend(sendBtn, strip, id);
    wireAlreadyDone(doneBtn, strip, id);
  }

  function wireAlreadyDone(btn, strip, clientId){
    btn.addEventListener("click", function(){
      if(!confirm("Mark the clinical screener as already completed?\n\nThe reminders stop and nothing is emailed to the family. No answers are recorded — only that it was done.")) return;
      btn.disabled = true;
      btn.textContent = "Saving…";
      fetch("/api/screener/mark-complete/" + clientId, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({}),
      }).then(function(r){ return r.json().catch(function(){ return {}; }).then(function(d){ return { ok: r.ok, d: d }; }); })
        .then(function(res){
          if(!res.ok){
            btn.disabled = false;
            btn.textContent = "✓ Already done";
            alert((res.d && res.d.error) || "Could not mark it complete.");
            return;
          }
          btn.textContent = "✓ Marked done";
          if(strip) strip.textContent = "Screener marked as already completed.";
        })
        .catch(function(e){
          btn.disabled = false;
          btn.textContent = "✓ Already done";
          alert(e.message || "Could not mark it complete.");
        });
    });
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
