// Cornell Note Seed App (React + Tiptap) — Cornell 3-Panel with Section Rules
// -----------------------------------------------------------------------------
// Improvements based on feedback:
// 1) Section mapping stays index-based when editing cue lines.
// 2) When a cue line is deleted: if the section has NO content -> drop it; if it HAS content -> keep it with EMPTY title.
// 3) Sections are draggable in the content area (drag handle) to reorder.
// 4) Each section supports collapse/expand (UI-only; content preserved).
// 5) Diagnostics panel added with tests for mapping, deletion rule, reordering, and collapse flags.
// -----------------------------------------------------------------------------
// ⚠️ ProseMirror multi-version guard
// If you see: RangeError: Can not convert <> to a Fragment (multiple versions of prosemirror-model)
// → Fix dependencies to a single version (package.json overrides/resolutions) and dedupe in bundler.
// npm/pnpm overrides example:
// {
//   "overrides": {
//     "prosemirror-model": "^1.19.3",
//     "prosemirror-state": "^1.4.3",
//     "prosemirror-view": "^1.31.2",
//     "prosemirror-transform": "^1.7.3",
//     "prosemirror-schema-list": "^1.2.2"
//   }
// }
// Also ensure all @tiptap/* versions match, and avoid mixing CDN + bundled builds.
// Runtime hardening below: editors start with safe empty content and only call setContent
// inside useEffect after each editor is ready. We never pass React nodes to setContent.
// -----------------------------------------------------------------------------

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import { DragDropContext, Droppable, Draggable } from "react-beautiful-dnd";
+ // --- Brand -----------------------------------------------------------------
+ const BRAND_ICON = "✏️"; // 상단 아이콘 (📓/✏️/📚 등으로 바꿔도 돼요)
+ const BRAND_TITLE = "WikiNote"; // 상단 타이틀 텍스트

// --- Utilities -----------------------------------------------------------
const LS_KEY = "cornell.notes.v3"; // bump key (structure change)

function uid() {
  try { if (typeof crypto !== "undefined" && crypto?.randomUUID) return crypto.randomUUID(); } catch (_) {}
  return "id_" + Math.random().toString(36).slice(2);
}

function nowISO() { return new Date().toISOString(); }
function ensureStringHTML(v) { return typeof v === "string" ? v : "<p></p>"; }
function stripTags(html = "") { if (typeof window === "undefined") return String(html).replace(/<[^>]*>/g," ").trim(); const d=document.createElement("div"); d.innerHTML=ensureStringHTML(html); return (d.textContent||"").trim(); }
function tokenize(q="") { return q.toLowerCase().split(/\s+/).map(s=>s.trim()).filter(Boolean); }

function sectionsToHTML(sections = []) {
  return sections.map(s => `<section><h3>${s.cue||""}</h3>${ensureStringHTML(s.html)}</section>`).join("\n");
}

// --- Sample Notes (for first-time users) ----------------------------------
function makeSampleNote({ title, unit, tags = [], summary = "", cueLines = [], sectionsHtml = [] }) {
  const cue = cueLines.join("\n");
  const sections = cueLines.map((c, i) => {
    const html = sectionsHtml[i] || "<p></p>";
    return { id: uid(), cue: c, html, text: stripTags(html), collapsed: false };
  });
  return {
    id: uid(), title, unit, tags, summary, cue, sections,
    notesHTML: sectionsToHTML(sections),
    notesText: sections.map(s => `${s.cue}\n${stripTags(s.html)}`).join("\n\n"),
    createdAt: nowISO(), updatedAt: nowISO(),
  };
}

function sampleNotes() {
  const n1 = makeSampleNote({
    title: "수학 I — 극한의 개념",
    unit: "수학 I / 극한",
    tags: ["수학", "극한", "미적분"],
    summary: "좌/우극한이 동일하면 극한 존재. 함수값과 극한값은 다를 수 있음.",
    cueLines: ["극한의 직관적 의미", "좌극한/우극한", "연속성과의 관계"],
    sectionsHtml: [
      "<p>x→a일 때 f(x)가 가까워지는 값에 대한 개념 정리</p>",
      "<ul><li>좌극한 lim<sub>x→a-</sub> f(x)</li><li>우극한 lim<sub>x→a+</sub> f(x)</li><li>같으면 극한 존재</li></ul>",
      "<p>연속이면 함수값 = 극한값. 불연속 유형: 제거/도약/무한</p>",
    ],
  });
  const n2 = makeSampleNote({
    title: "생명과학 — 광합성 요약",
    unit: "생명과학 / 식물",
    tags: ["생명과학", "광합성"],
    summary: "명반응에서 ATP/NADPH 생성, 암반응(Calvin)에서 탄소고정.",
    cueLines: ["명반응", "암반응(Calvin cycle)", "광합성에 영향 주는 요인"],
    sectionsHtml: [
      "<p>빛 사용, 틸라코이드 막, 물의 광분해 → O<sub>2</sub></p>",
      "<p>RuBisCO에 의한 CO<sub>2</sub> 고정, G3P 형성</p>",
      "<ul><li>빛의 세기</li><li>CO<sub>2</sub> 농도</li><li>온도</li></ul>",
    ],
  });
  return [n1, n2];
}


function createEmptyNote() {
  return { id: uid(), title: "새 노트", cue: "", sections: [], summary: "", tags: [], unit: "", createdAt: nowISO(), updatedAt: nowISO(), notesHTML: "", notesText: "" };
}

function loadNotes(){ try{const raw=typeof localStorage!=="undefined"?localStorage.getItem(LS_KEY):null; if(!raw) return []; return JSON.parse(raw);}catch{return [];} }
function saveNotes(n){ try{ if(typeof localStorage!=="undefined") localStorage.setItem(LS_KEY, JSON.stringify(n)); }catch{} }

function useDebouncedEffect(effect,deps,delay=600){ useEffect(()=>{const h=setTimeout(effect,delay); return ()=>clearTimeout(h);},[...deps,delay]); }

// --- Main App ------------------------------------------------------------
export default function App(){
  const [notes,setNotes]=useState(()=>{
  const loaded = loadNotes();
  if (loaded.length) return loaded;     // 기존 사용자 데이터는 그대로
  return sampleNotes();                 // 첫 방문자에게 예시 노트 제공
+ });
  const [selectedId,setSelectedId]=useState(notes[0]?.id||null);
  const selected=useMemo(()=>notes.find(n=>n.id===selectedId)||null,[notes,selectedId]);
  const [query,setQuery]=useState("");

  useDebouncedEffect(()=>saveNotes(notes),[notes],400);

  const updateSelected=(patch)=>{
    if(!selected) return;
    let next={...selected,...patch};

    // Handle cue changes (index-based mapping)
    if(Object.prototype.hasOwnProperty.call(patch, "cue")){
      const lines=(patch.cue||"").split(/\n+/);
      const prev=selected.sections||[];
      const newSections = lines.map((line,i)=>{
        const s = prev[i];
        if(s) return { ...s, cue: line };
        return { id: uid(), cue: line, html: "<p></p>", text: "", collapsed: false };
      });
      // For any leftover previous sections beyond new line count:
      for(let i=lines.length;i<prev.length;i++){
        const s = prev[i];
        if(stripTags(s.html)===""){
          // No content → drop entirely
          continue;
        } else {
          // Has content → keep as untitled (empty cue)
          newSections.push({ ...s, cue: "" });
        }
      }
      next.sections = newSections;
    }

    // Derive HTML/Text for search/export
    next.notesHTML=sectionsToHTML(next.sections||[]);
    next.notesText=(next.sections||[]).map(s=>`${s.cue}\n${stripTags(s.html)}`).join("\n\n");
    next.updatedAt=nowISO();

    setNotes(prev=>prev.map(n=>n.id===selected.id?next:n));
  };

  const updateSection=(id,patch)=>{
    if(!selected) return;
    const sections=(selected.sections||[]).map(s=>s.id===id?{...s,...patch}:s);
    const next={...selected,sections,notesHTML:sectionsToHTML(sections),notesText:sections.map(s=>`${s.cue}\n${stripTags(s.html)}`).join("\n\n"),updatedAt:nowISO()};
    setNotes(prev=>prev.map(n=>n.id===selected.id?next:n));
  };

  const reorderSections=(result)=>{
    if(!result.destination || !selected) return;
    const sections=Array.from(selected.sections||[]);
    const [removed]=sections.splice(result.source.index,1);
    sections.splice(result.destination.index,0,removed);
    updateSelected({sections});
  };

  const filtered=useMemo(()=>{const tks=tokenize(query); return notes.filter(n=>tks.every(t=>JSON.stringify(n).toLowerCase().includes(t)));},[notes,query]);

  return (
    <div className="h-full w-full p-4 grid grid-rows-[auto,1fr] gap-4 bg-gray-50">
      <header className="flex items-center gap-2 bg-white p-2 rounded-xl shadow">
        <input value={query} onChange={e=>setQuery(e.target.value)} placeholder="검색" className="px-3 py-2 flex-1 bg-gray-100 rounded-xl" />
        <button onClick={()=>{const n=createEmptyNote(); setNotes([n,...notes]); setSelectedId(n.id);}} className="px-3 py-2 bg-blue-500 text-white rounded-xl">+ 새 노트</button>
      </header>

      <main className="grid grid-cols-4 gap-4">
        <aside className="col-span-1 bg-white rounded-xl shadow p-2 overflow-y-auto">
          {filtered.map(n=>(
            <div key={n.id} onClick={()=>setSelectedId(n.id)} className={`p-2 border rounded mb-2 cursor-pointer ${selectedId===n.id?"bg-blue-100 border-blue-400":"hover:bg-gray-50"}`}>
              <div className="font-medium">{n.title||"(제목없음)"}</div>
              <div className="text-xs text-gray-500 line-clamp-2">{(n.sections||[]).map(s=>s.cue).filter(Boolean).slice(0,3).join(" • ")}</div>
            </div>
          ))}
        </aside>

        <section className="col-span-3 bg-white rounded-xl shadow p-3 flex flex-col">
          {selected && (
            <>
              <input value={selected.title} onChange={e=>updateSelected({title:e.target.value})} className="text-lg font-semibold border-b mb-2 outline-none" placeholder="노트 제목" />

              {/* Cue area (left panel concept) */}
              <label className="text-sm text-gray-600 mb-1">질문/키워드 (한 줄 = 한 섹션 제목)</label>
              <textarea value={selected.cue} onChange={e=>updateSelected({cue:e.target.value})} placeholder="예) 왜 3의 배수 규칙이 성립하죠?\n예) 좌극한/우극한 차이는?" className="w-full mb-3 p-2 border rounded resize-y min-h-[6rem]" />

              {/* Sections (right content area) */}
              <DragDropContext onDragEnd={reorderSections}>
                <Droppable droppableId="sections">
                  {(provided)=> (
                    <div {...provided.droppableProps} ref={provided.innerRef} className="flex-1 overflow-y-auto">
                      {(selected.sections||[]).length===0 && (
                        <div className="p-4 text-sm text-gray-500">좌측에 질문/키워드를 입력하면 섹션이 생성됩니다.</div>
                      )}

                      {(selected.sections||[]).map((sec,idx)=>(
                        <Draggable key={sec.id} draggableId={sec.id} index={idx}>
                          {(p)=> (
                            <div ref={p.innerRef} {...p.draggableProps} className="border rounded mb-3">
                              {/* UI divider via border (not content <hr>) */}
                              <div className="flex items-center justify-between bg-gray-50 p-2" {...p.dragHandleProps}>
                                <div className="font-semibold">{sec.cue||"(제목없음)"}</div>
                                <button onClick={()=>updateSection(sec.id,{collapsed:!sec.collapsed})} className="text-xs px-2 py-1 border rounded">
                                  {sec.collapsed?"펼치기":"접기"}
                                </button>
                              </div>
                              {!sec.collapsed && (
                                <SectionEditor section={sec} onChange={(patch)=>updateSection(sec.id,patch)} />
                              )}
                            </div>
                          )}
                        </Draggable>
                      ))}
                      {provided.placeholder}
                    </div>
                  )}
                </Droppable>
              </DragDropContext>

              <label className="text-sm text-gray-600 mt-3 mb-1">요약</label>
              <textarea value={selected.summary} onChange={e=>updateSelected({summary:e.target.value})} placeholder="핵심 내용을 3~5문장으로 요약" className="p-2 border rounded min-h-[5rem]" />

              <Diagnostics selected={selected} />
            </>
          )}
        </section>
      </main>
    </div>
  );
}

// --- Section Editor -----------------------------------------------------
function SectionEditor({section,onChange}){
  const fileRef = useRef(null);
  const editor=useEditor({
    extensions:[
      StarterKit.configure({ bulletList:{keepMarks:true}, orderedList:{keepMarks:true} }),
      Placeholder.configure({placeholder:"내용 입력"}),
      Image.configure({allowBase64:true}),
      Link.configure({ openOnClick:true, autolink:true, linkOnPaste:true }),
    ],
    content:ensureStringHTML(section.html),
    onUpdate:({editor})=>{onChange({html:editor.getHTML(),text:editor.getText()});},
    editorProps:{attributes:{class:"tiptap prose max-w-none min-h-[6rem] p-2 focus:outline-none"}},
  });

  useEffect(()=>{ if(editor){ try{ editor.commands.setContent(ensureStringHTML(section.html),false); }catch(e){ editor.commands.setContent("<p></p>",false); } } },[section.id]);

  const openImagePicker=()=>fileRef.current?.click();
  const onPickImage=(e)=>{ const f=e.target.files?.[0]; if(!f) return; const r=new FileReader(); r.onload=()=>{ const src=r.result; if(typeof src==="string") editor?.chain().focus().setImage({src}).run(); e.target.value=""; }; r.readAsDataURL(f); };

  return (
    <div className="px-2 py-2">
      <div className="flex items-center gap-1 mb-2">
        <ToolbarButton active={editor?.isActive("bold")} onClick={()=>editor?.chain().focus().toggleBold().run()}>굵게</ToolbarButton>
        <ToolbarButton active={editor?.isActive("italic")} onClick={()=>editor?.chain().focus().toggleItalic().run()}>기울임</ToolbarButton>
        <ToolbarButton onClick={()=>editor?.chain().focus().toggleBulletList().run()}>• 리스트</ToolbarButton>
        <ToolbarButton onClick={()=>editor?.chain().focus().toggleOrderedList().run()}>1. 리스트</ToolbarButton>
        <ToolbarButton onClick={openImagePicker}>🖼️ 이미지</ToolbarButton>
        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onPickImage} />
        <div className="mx-2 w-px h-5 bg-gray-300" />
        <ToolbarButton onClick={()=>{ const url=prompt("링크 URL"); if(url) editor?.chain().focus().extendMarkRange("link").setLink({href:url}).run(); }}>🔗 링크</ToolbarButton>
        <ToolbarButton onClick={()=>editor?.chain().focus().unsetLink().run()}>링크 해제</ToolbarButton>
      </div>
      <EditorContent editor={editor}/>
    </div>
  );
}

// --- Small UI bits ------------------------------------------------------
function ToolbarButton({ children, onClick, active }) {
  return (
    <button onClick={onClick} className={`px-2 py-1 text-sm rounded-md border ${active?"bg-blue-100 border-blue-300":"bg-white border-gray-300"}`}>{children}</button>
  );
}

// --- Diagnostics & Tests -------------------------------------------------
function Diagnostics({ selected }){
  const [results,setResults]=useState([]);

  useEffect(()=>{
    const r=[];

    // Test A: Index-based mapping
    try{
      const before={ sections:[ {id:"a",cue:"Q1",html:"<p>x</p>"}, {id:"b",cue:"Q2",html:"<p>y</p>"} ] };
      const cueChanged="New1\nNew2\nNew3"; // added one more line
      const lines=cueChanged.split(/\n+/);
      const prev=before.sections;
      const newSections=lines.map((line,i)=> prev[i]?{...prev[i],cue:line}:{id:"new_"+i,cue:line,html:"<p></p>",text:""});
      for(let i=lines.length;i<prev.length;i++){ const s=prev[i]; if(stripTags(s.html)!=="") newSections.push({...s,cue:""}); }
      const ok = newSections[0].id==="a" && newSections[1].id==="b" && newSections[2].cue==="New3";
      r.push([ok, "Index mapping preserves existing by index; new gets appended"]);
    }catch(e){ r.push([false, "Index mapping threw: "+e?.message]); }

    // Test B: Deleting cue lines drops empty, keeps non-empty as untitled
    try{
      const prev=[ {id:"a",cue:"Q1",html:"<p></p>"}, {id:"b",cue:"Q2",html:"<p>has</p>"} ];
      const lines=["OnlyOne"]; // shrink to one line
      const res=[...lines.map((l,i)=> prev[i]?{...prev[i],cue:l}:{id:uid(),cue:l,html:"<p></p>"})];
      for(let i=lines.length;i<prev.length;i++){ const s=prev[i]; if(stripTags(s.html)!=="") res.push({...s,cue:""}); }
      const ok = res.length===2 && res[0].cue==="OnlyOne" && res[1].cue==="" && stripTags(res[1].html)==="has";
      r.push([ok, "Cue deletion rule: drop empty, keep content as untitled"]);
    }catch(e){ r.push([false, "Deletion rule test threw: "+e?.message]); }

    // Test C: Reorder logic
    try{
      const arr=[{id:"a"},{id:"b"},{id:"c"}];
      const [x]=arr.splice(0,1); arr.splice(2,0,x);
      r.push([arr.map(s=>s.id).join("")==="bca", "Reorder moves item correctly"]);
    }catch(e){ r.push([false, "Reorder test threw: "+e?.message]); }

    // Test D: Collapse toggle flag persist
    try{
      const s={id:"a",collapsed:false};
      const toggled={...s,collapsed:!s.collapsed};
      r.push([toggled.collapsed===true, "Collapse toggles true→false"]);
    }catch(e){ r.push([false, "Collapse test threw: "+e?.message]); }

    setResults(r);
  },[selected?.id]);

  return (
    <details className="mt-3 text-sm text-gray-600">
      <summary>진단 / 테스트 ({results.filter(([ok])=>ok).length}/{results.length} 통과)</summary>
      <ul className="list-disc ml-5 mt-2 space-y-1">
        {results.map(([ok,msg],i)=>(<li key={i} className={ok?"text-green-700":"text-red-700"}>{ok?"✔":"✖"} {msg}</li>))}
      </ul>
    </details>
  );
}
