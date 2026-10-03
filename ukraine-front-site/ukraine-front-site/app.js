const map=L.map('map',{zoomControl:true}).setView([49.0,31.2],6);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
 maxZoom:19, attribution:'&copy; OpenStreetMap contributors'
}).addTo(map);

/* Постоянная синяя заливка Украины. Это отдельный базовый слой:
   пользовательские территории рисуются поверх него. */
const ukraineBase = L.layerGroup().addTo(map);
const currentFrontLayer = L.layerGroup().addTo(map);
const TERRITORY_OPACITY = 0.30;
let ukraineGeoJSON = null;
let currentRussiaGeoJSON = null;
let baseTerritoryFeatures = [];
let territoryFeatures = [];
let initialTerritoryFeatures = [];
const UA_COLOR = '#1976d2';
const RU_COLOR = '#d32f2f';
let userHasPainted=false;
let sourceContactFeatures=[];

fetch('https://raw.githubusercontent.com/johan/world.geo.json/master/countries/UKR.geo.json')
  .then(r => {
    if (!r.ok) throw new Error('Ukraine GeoJSON HTTP ' + r.status);
    return r.json();
  })
  .then(data => {
    ukraineGeoJSON = data;
    rebuildBackgroundTerritories();
  })
  .catch(() => {
    /* Если внешний GeoJSON недоступен, карта всё равно работает. */
  });


/* Текущая российская контролируемая территория из ежедневного GeoJSON. */
function rebuildBackgroundTerritories(){
  ukraineBase.clearLayers();
  // Базовые территории собираются в единый набор геометрий.
  // Это позволяет при рисовании реально ЗАМЕНЯТЬ цвет участка,
  // а не накладывать новый полупрозрачный слой поверх старого.
  baseTerritoryFeatures=[];
  if(ukraineGeoJSON){
    const fs=(ukraineGeoJSON.type==='FeatureCollection'?ukraineGeoJSON.features:[ukraineGeoJSON]);
    fs.forEach(f=>{
      if(f && f.geometry) baseTerritoryFeatures.push({type:'Feature',properties:{side:'ua',base:true},geometry:f.geometry});
    });
  }
  if(currentRussiaGeoJSON){
    const fs=currentRussiaGeoJSON.features||[];
    fs.forEach(f=>{
      if(f && f.geometry) baseTerritoryFeatures.push({type:'Feature',properties:{side:'ru',base:true},geometry:f.geometry});
    });
  }
  // Начальное состояние: Украина синяя, а актуальная красная зона
  // вырезается из синей территории, чтобы цвета не смешивались уже при старте.
  let uaFeatures = baseTerritoryFeatures
    .filter(f=>f.properties?.side==='ua')
    .map(f=>JSON.parse(JSON.stringify(f)));
  const ruFeatures = baseTerritoryFeatures
    .filter(f=>f.properties?.side==='ru')
    .map(f=>JSON.parse(JSON.stringify(f)));

  // Последовательно вырезаем актуальную красную зону из Украины.
  for (const ru of ruFeatures) {
    const next=[];
    for (const ua of uaFeatures) {
      try {
        const diff=turf.difference(turf.featureCollection([ua, ru]));
        if(!diff) continue;
        if(diff.geometry?.type==='MultiPolygon') {
          turf.featureEach(diff, piece=>next.push({
            type:'Feature', properties:{side:'ua',base:true}, geometry:piece.geometry
          }));
        } else if(diff.geometry) {
          next.push({type:'Feature',properties:{side:'ua',base:true},geometry:diff.geometry});
        }
      } catch(e) {
        next.push(ua);
      }
    }
    uaFeatures=next;
  }

  territoryFeatures=[...uaFeatures,...ruFeatures];
  initialTerritoryFeatures=territoryFeatures.map(f=>JSON.parse(JSON.stringify(f)));
  renderTerritories();
}

function renderTerritories(){
  territoryLayer.clearLayers();
  territoryFeatures.forEach(f=>{
    const side=f.properties?.side==='ru'?'ru':'ua';
    L.geoJSON(f,{style:{color:'transparent',weight:0,fillColor:side==='ru'?RU_COLOR:UA_COLOR,fillOpacity:TERRITORY_OPACITY}}).addTo(territoryLayer);
  });
}

function replaceAreaWithNewColor(newFeature, newSide){
  const next=[];
  for(const old of territoryFeatures){
    try{
      const clipped=turf.difference(turf.featureCollection([old,newFeature]));
      if(clipped){
        if(clipped.geometry?.type==='GeometryCollection') continue;
        const pieces=clipped.geometry?.type==='MultiPolygon' ? turf.featureEach(clipped, piece=>next.push({type:'Feature',properties:{...(old.properties||{}),side:old.properties?.side||'ua'},geometry:piece.geometry})) : [{type:'Feature',properties:{...(old.properties||{}),side:old.properties?.side||'ua'},geometry:clipped.geometry}];
        if(Array.isArray(pieces)) next.push(...pieces);
      }
    }catch(e){
      // Если конкретная геометрия не обработалась, не удаляем её.
      next.push(old);
    }
  }
  next.push({type:'Feature',properties:{side:newSide,base:false},geometry:newFeature.geometry});
  territoryFeatures=next;
  renderTerritories();
}

function restoreSourceFront(){
  currentFrontLayer.clearLayers();
  sourceContactFeatures.forEach(f=>{
    if(f && f.geometry) L.geoJSON(f,{style:{color:RU_COLOR,weight:3,opacity:.9,fill:false,interactive:false}}).addTo(currentFrontLayer);
  });
  currentFrontLayer.bringToFront();
}

function updateFrontFromTerritories(){
  if(!userHasPainted){ restoreSourceFront(); return; }
  currentFrontLayer.clearLayers();
  const reds=territoryFeatures.filter(f=>f.properties?.side==='ru' && f.geometry);
  if(!reds.length) return;
  try{
    const fc=turf.featureCollection(reds);
    let merged=null;
    if(reds.length===1) merged=reds[0];
    else merged=turf.union(fc);
    if(!merged || !merged.geometry) return;
    const line=turf.polygonToLine(merged);
    L.geoJSON(line,{style:{color:RU_COLOR,weight:3,opacity:.9,fill:false,interactive:false}}).addTo(currentFrontLayer);
    currentFrontLayer.bringToFront();
  }catch(e){
    console.warn('Не удалось пересчитать фронт',e);
  }
}

async function loadCurrentFront() {
  const url = 'https://longlinecode.github.io/russo-ukrainian-front-daily/data/latest.geojson';
  try {
    const response = await fetch(url, {cache:'no-store'});
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const data = await response.json();
    currentRussiaGeoJSON = {
      type:'FeatureCollection',
      features:(data.features || []).filter(f => f.properties?.kind === 'russian_control')
    };

    // Загружаем именно актуальную линию соприкосновения отдельным слоем.
    // Она не является пользовательской линией и не удаляется при рисовании.
    currentFrontLayer.clearLayers();
    const contactFeatures=(data.features || []).filter(f => f.properties?.kind === 'contact_line');
    sourceContactFeatures=contactFeatures;
    contactFeatures.forEach(f=>{
      if(f && f.geometry){
        L.geoJSON(f,{
          style:{color:RU_COLOR,weight:3,opacity:.9,fill:false,interactive:false}
        }).addTo(currentFrontLayer);
      }
    });

    rebuildBackgroundTerritories();

    // Линия текущего фронта всегда сверху всех заливок.
    territoryLayer.bringToFront();
    userFrontLayer.bringToFront();
    currentFrontLayer.bringToFront();
    setStatus('<b>Актуальная красная зона загружена.</b><br>Дата данных: ' +
      (data.properties?.data_date || 'не указана'));
  } catch (e) {
    setStatus('<b>Линия фронта не загрузилась.</b><br>Обнови страницу при наличии интернета.');
    console.error(e);
  }
}
/* Слои намеренно разделены: линия фронта никогда не удаляется
   действиями пользователя. */
const territoryLayer=L.layerGroup().addTo(map);
const grayLayer=L.layerGroup().addTo(map);
const userFrontLayer=L.layerGroup().addTo(map);

// Загружаем текущий фронт только после создания всех слоёв,
// чтобы первая отрисовка цветов гарантированно не падала.
loadCurrentFront();

let side='ua';
let mode='overview';
let drawing=false;
let points=[];
let tempLine=null;
let grayKm=0;
const history=[];

function sideColor(){return side==='ua'?UA_COLOR:RU_COLOR}

function setStatus(t){document.getElementById('status').innerHTML=t}

function record(type,obj){
 history.push({type,obj,features:type==='territory'?territoryFeatures.map(f=>JSON.parse(JSON.stringify(f))):null});
}

// Проверяем, пересекает ли новый отрезок один из старых отрезков пути.
// Это не даёт Leaflet/Turf построить самопересекающийся полигон и создать
// большие случайные треугольники/веера.
function orient(a,b,c){
  return (b.lng-a.lng)*(c.lat-a.lat)-(b.lat-a.lat)*(c.lng-a.lng);
}
function onSegment(a,b,p){
  return Math.min(a.lng,b.lng)-1e-10<=p.lng && p.lng<=Math.max(a.lng,b.lng)+1e-10 &&
         Math.min(a.lat,b.lat)-1e-10<=p.lat && p.lat<=Math.max(a.lat,b.lat)+1e-10;
}
function segmentsIntersect(a,b,c,d){
  const o1=orient(a,b,c), o2=orient(a,b,d), o3=orient(c,d,a), o4=orient(c,d,b);
  const eps=1e-12;
  if(((o1>eps&&o2<-eps)||(o1<-eps&&o2>eps)) && ((o3>eps&&o4<-eps)||(o3<-eps&&o4>eps))) return true;
  if(Math.abs(o1)<=eps && onSegment(a,b,c)) return true;
  if(Math.abs(o2)<=eps && onSegment(a,b,d)) return true;
  if(Math.abs(o3)<=eps && onSegment(c,d,a)) return true;
  if(Math.abs(o4)<=eps && onSegment(c,d,b)) return true;
  return false;
}
function pathWouldCross(candidate){
  if(points.length<3) return false;
  const a=points[points.length-1], b=candidate;
  // Сравниваем новый отрезок только с непоследовательными старыми отрезками.
  for(let i=0;i<points.length-2;i++){
    if(segmentsIntersect(a,b,points[i],points[i+1])) return true;
  }
  return false;
}
function closingWouldCross(path){
  if(path.length<4) return false;
  const a=path[path.length-1], b=path[0];
  // Последний->первый не должен пересекать внутренние рёбра.
  for(let i=1;i<path.length-2;i++){
    if(segmentsIntersect(a,b,path[i],path[i+1])) return true;
  }
  return false;
}

function finishTerritory(){
 if(points.length<3){
   if(tempLine) territoryLayer.removeLayer(tempLine);
   tempLine=null;points=[];return;
 }
 if(tempLine) territoryLayer.removeLayer(tempLine);

 const path=points.slice();
 // Не создаём самопересекающиеся полигоны. Если замыкание пересекает путь,
 // обрезаем только хвост, не трогая остальные территории.
 while(path.length>=4 && closingWouldCross(path)) path.pop();
 if(path.length<3){ tempLine=null;points=[];return; }

 const ring=[...path.map(p=>[p.lng,p.lat]),[path[0].lng,path[0].lat]];
 let result;
 try{ result=turf.polygon([ring]); }catch(e){ tempLine=null;points=[];return; }

 const newFeature={type:'Feature',properties:{side:side,base:false},geometry:result.geometry};
 // Главное: новый цвет ВЫРЕЗАЕТ этот участок из старого синего/красного.
 // Поэтому красное под синим исчезает и наоборот — остаётся один цвет 30%.
 replaceAreaWithNewColor(newFeature,side);
 userHasPainted=true;
 updateFrontFromTerritories();

 const newest=territoryLayer.getLayers()[territoryLayer.getLayers().length-1];
 if(newest) record('territory',newest);
 rebuildGray();
 territoryLayer.bringToFront();
 userFrontLayer.bringToFront();
 tempLine=null;points=[];
 setStatus('Территория добавлена: '+(side==='ua'?'Украина':'Россия')+'. Новый цвет заменяет старый на этом участке.');
}

function startDraw(e){
 if(mode!=='paint') return;
 drawing=true;
 points=[e.latlng];
 tempLine=L.polyline(points,{color:sideColor(),weight:3,opacity:.9,dashArray:'8 8',lineCap:'round',lineJoin:'round'});
 territoryLayer.addLayer(tempLine);
 map.dragging.disable();
}

function moveDraw(e){
 if(!drawing)return;
 const last=points[points.length-1];
 if(!last || map.distance(last,e.latlng)>8){
   if(pathWouldCross(e.latlng)) return;
   points.push(e.latlng);
   tempLine.setLatLngs(points);
 }
}

function endDraw(){
 if(!drawing)return;
 drawing=false;
 map.dragging.enable();
 finishTerritory();
}

map.on('mousedown',startDraw);
map.on('mousemove',moveDraw);
map.on('mouseup',endDraw);
map.on('mouseleave',endDraw);

/* Смена режима */
document.getElementById('overviewMode').onclick=()=>{
 mode='overview';
 map.dragging.enable();
 document.getElementById('overviewMode').classList.add('active');
 document.getElementById('paintMode').classList.remove('active');
 document.getElementById('paintControls').style.display='none';
 setStatus('Режим обзора: карта свободно перемещается мышью.');
};
document.getElementById('paintMode').onclick=()=>{
 mode='paint';
 map.dragging.enable();
 document.getElementById('paintMode').classList.add('active');
 document.getElementById('overviewMode').classList.remove('active');
 document.getElementById('paintControls').style.display='block';
 setStatus('Режим территории: зажми левую кнопку и обведи участок. Пунктир показывает контур.');
};

document.getElementById('ua').onclick=()=>{
 side='ua';
 document.getElementById('ua').classList.add('active');
 document.getElementById('ru').classList.remove('active');
};
document.getElementById('ru').onclick=()=>{
 side='ru';
 document.getElementById('ru').classList.add('active');
 document.getElementById('ua').classList.remove('active');
};

function rebuildGray(){
  grayLayer.clearLayers();
  if(grayKm<=0){ currentFrontLayer.bringToFront(); return; }
  // Серую зону строим ТОЛЬКО вокруг актуальной линии фронта,
  // а не вокруг всех территориальных полигонов.
  try{
    const frontGeo = currentFrontLayer.toGeoJSON();
    if(frontGeo && frontGeo.features && frontGeo.features.length){
      const buffered = turf.buffer(frontGeo, grayKm, {units:'kilometers'});
      if(buffered){
        L.geoJSON(buffered,{
          style:{color:'transparent',fillColor:'#aaa',fillOpacity:.30,weight:0,interactive:false}
        }).addTo(grayLayer);
      }
    }
  }catch(e){
    console.warn('Не удалось построить серую зону',e);
  }
  grayLayer.bringToBack();
  territoryLayer.bringToFront();
  userFrontLayer.bringToFront();
  currentFrontLayer.bringToFront();
}

document.getElementById('gray').oninput=e=>{
 grayKm=Number(e.target.value);
 document.getElementById('grayValue').textContent=grayKm+' км';
 rebuildGray();
};

document.getElementById('undo').onclick=()=>{
 const item=history.pop();
 if(!item)return;
 if(item.type==='front') userFrontLayer.removeLayer(item.obj);
 if(item.type==='territory'){
   // Восстанавливаем геометрию до последнего рисования.
   // Сохраняется и базовый фронт, и все предыдущие перекрытия.
   const previous=history.slice().reverse().find(x=>x.type==='territory' && x.features);
   territoryFeatures=previous ? previous.features.map(f=>JSON.parse(JSON.stringify(f))) : initialTerritoryFeatures.map(f=>JSON.parse(JSON.stringify(f)));
   renderTerritories();
   userHasPainted=history.some(x=>x.type==='territory');
   updateFrontFromTerritories();
 }
 rebuildGray();
 setStatus('Последнее изменение удалено. Актуальная линия фронта не затронута.');
};

document.getElementById('clearScenario').onclick=()=>{
 territoryLayer.clearLayers();
 grayLayer.clearLayers();
 userFrontLayer.clearLayers();
 history.length=0;
 userHasPainted=false;
 territoryFeatures=baseTerritoryFeatures.map(f=>JSON.parse(JSON.stringify(f)));
 renderTerritories();
 restoreSourceFront();
 rebuildGray();
 setStatus('Твой сценарий очищен. Фактическая линия фронта осталась.');
};

/* Все базовые и нарисованные территории используют одинаковую прозрачность 30%.
   При рисовании новый цвет заменяет старый только внутри нарисованного участка.
   Актуальная линия фронта хранится в отдельном слое и не удаляется. */
