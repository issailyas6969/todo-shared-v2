const express = require('express');
const path = require('path');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  ScanCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand
} = require('@aws-sdk/lib-dynamodb');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());

// DynamoDB setup
const ddbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const ddb = DynamoDBDocumentClient.from(ddbClient);
const TABLE_NAME = process.env.TABLE_NAME;

// Serve health check
app.get('/health', (req, res) => {
  res.status(200).send('ok');
});

// Serve front‑end
app.get('/', (req, res) => {
  res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Shared To‑Do List</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root {
  --bg:#fff;
  --text:#111;
  --accent:#0066ff;
  --border:#ddd;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg:#111;
    --text:#eee;
    --accent:#3399ff;
    --border:#444;
  }
}
*{box-sizing:border-box;margin:0;padding:0;}
body{
  font-family:system-ui,sans-serif;
  background:var(--bg);
  color:var(--text);
  line-height:1.5;
  padding:1rem;
}
h1{font-size:1.5rem;margin-bottom:.5rem;}
#app{max-width:600px;margin:auto;}
input[type=text]{
  width:100%;
  padding:.5rem;
  border:1px solid var(--border);
  border-radius:4px;
  margin-bottom:.5rem;
  background:var(--bg);
  color:var(--text);
}
button{
  padding:.5rem 1rem;
  background:var(--accent);
  color:#fff;
  border:none;
  border-radius:4px;
  cursor:pointer;
}
button:disabled{opacity:.5;cursor:not-allowed;}
ul{list-style:none;margin-top:1rem;}
li{
  display:flex;
  align-items:center;
  justify-content:space-between;
  padding:.5rem 0;
  border-bottom:1px solid var(--border);
}
li.done span{text-decoration:line-through;color:gray;}
li span{flex:1;margin-left:.5rem;}
li .actions button{
  background:none;
  color:var(--accent);
  margin-left:.5rem;
}
.counter{margin-top:.5rem;font-weight:600;}
@media (max-width:600px){
  body{padding:.5rem;}
}
</style>
</head>
<body>
<div id="app">
  <h1>Shared To‑Do List</h1>
  <input type="text" id="newTask" placeholder="What needs to be done?" autocomplete="off">
  <button id="addBtn">Add</button>
  <ul id="taskList"></ul>
  <div class="counter" id="counter"></div>
</div>
<script>
const api = {
  getTasks:()=>fetch('/tasks').then(r=>r.json()),
  addTask:(text)=>fetch('/tasks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text})}).then(r=>r.json()),
  toggleDone:(id,done)=>fetch('/tasks/'+id,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({done})}),
  deleteTask:(id)=>fetch('/tasks/'+id,{method:'DELETE'})
};

function render(tasks){
  const list = document.getElementById('taskList');
  list.innerHTML='';
  tasks.sort((a,b)=>a.createdAt-b.createdAt);
  tasks.forEach(t=>{
    const li=document.createElement('li');
    li.className = t.done?'done':'';
    const checkbox=document.createElement('input');
    checkbox.type='checkbox';
    checkbox.checked=t.done;
    checkbox.addEventListener('change',()=>api.toggleDone(t.id,checkbox.checked).then(load));
    const span=document.createElement('span');
    span.textContent=t.text;
    const delBtn=document.createElement('button');
    delBtn.textContent='✕';
    delBtn.title='Delete';
    delBtn.addEventListener('click',()=>api.deleteTask(t.id).then(load));
    const actions=document.createElement('div');
    actions.className='actions';
    actions.appendChild(delBtn);
    li.appendChild(checkbox);
    li.appendChild(span);
    li.appendChild(actions);
    list.appendChild(li);
  });
  document.getElementById('counter').textContent = \`\${tasks.filter(t=>!t.done).length} task(s) left\`;
}

function load(){
  api.getTasks().then(render);
}

document.getElementById('addBtn').addEventListener('click',()=> {
  const input=document.getElementById('newTask');
  const text=input.value.trim();
  if(!text) return;
  api.addTask(text).then(()=>{input.value='';load();});
});

document.getElementById('newTask').addEventListener('keypress',e=>{
  if(e.key==='Enter'){
    e.preventDefault();
    document.getElementById('addBtn').click();
  }
});

load();
</script>
</body>
</html>`);
});

// API: get all tasks
app.get('/tasks', async (req, res) => {
  try {
    const data = await ddb.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': 'LIST' }
    }));
    const items = (data.Items || []).map(i=>({
      id: i.sk.replace('ITEM#',''),
      text: i.text,
      done: i.done,
      createdAt: i.createdAt
    }));
    res.json(items);
  } catch (err) {
    console.error(err);
    res.status(500).json({error:'Failed to fetch tasks'});
  }
});

// API: add task
app.post('/tasks', async (req, res) => {
  const { text } = req.body;
  if (!text || typeof text !== 'string') {
    return res.status(400).json({error:'Invalid task text'});
  }
  const id = uuidv4();
  const item = {
    pk: 'LIST',
    sk: `ITEM#${id}`,
    text: text.trim(),
    done: false,
    createdAt: Date.now()
  };
  try {
    await ddb.send(new PutCommand({TableName: TABLE_NAME, Item: item}));
    res.status(201).json({id});
  } catch (err) {
    console.error(err);
    res.status(500).json({error:'Failed to add task'});
  }
});

// API: toggle done
app.patch('/tasks/:id', async (req, res) => {
  const { id } = req.params;
  const { done } = req.body;
  if (typeof done !== 'boolean') {
    return res.status(400).json({error:'Invalid done flag'});
  }
  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { pk: 'LIST', sk: `ITEM#${id}` },
      UpdateExpression: 'SET done = :d',
      ExpressionAttributeValues: { ':d': done }
    }));
    res.json({ok:true});
  } catch (err) {
    console.error(err);
    res.status(500).json({error:'Failed to update task'});
  }
});

// API: delete task
app.delete('/tasks/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await ddb.send(new DeleteCommand({
      TableName: TABLE_NAME,
      Key: { pk: 'LIST', sk: `ITEM#${id}` }
    }));
    res.json({ok:true});
  } catch (err) {
    console.error(err);
    res.status(500).json({error:'Failed to delete task'});
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server listening on port ' + PORT));
});
