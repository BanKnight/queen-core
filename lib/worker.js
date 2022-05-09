const v8 = require('v8');
const { EventEmitter } = require('events');
const { workerData, parentPort, BroadcastChannel } = require('worker_threads');

let id = workerData.index << 24          //ant id的起始
let config = workerData.config
let workers = []
let ants = {}
let names = {}

let session = 0
let rpcs = {}
let plugins = require('./plugins')(config);

let QUEEN = Symbol("QUEEN")
let BROAD = new BroadcastChannel("$workers")

function run()
{
    const on = on_message.bind(QUEEN)

    parentPort.on('message', on);
    BROAD.onmessage = (event) =>
    {
        return on(event.data)
    }
}

run()

function new_id(force_id)
{
    if (force_id)
    {
        return force_id
    }

    while (++id)
    {
        if (!ants[id])
        {
            return id
        }
    }
}

function worker_index(id)
{
    return (id >> 24) % config.workers
}

function on_message(event)
{
    if (config.debug)
    {
        console.log(`worker[${workerData.index}]:on_message`, this, event)
    }

    switch (event.type)
    {
        case "connect": on_connect(this, event); break;
        case "call": on_call(this, event); break;
        case "post": on_post(this, event); break            //要求发给某个ant
        case "destroy": on_destroy(this, event); break
        case "regist": on_regist(this, event); break        //注册一个名字
        case "unregist": on_unregist(this, event); break    //反注册一个名字
        case "response": on_response(this, event); break;   //收到一个响应
        default: on_unknown(this, event); break;
    }
}

function on_connect(queen, event)
{
    let index = event.index
    let port = event.port

    let worker = {
        index,
        port,
    }

    workers[index] = worker

    port.on('message', on_message.bind(worker))
}

function on_call(worker, event)
{
    switch (event.name)
    {
        case "spawn": on_spawn(worker, event); break;
        default: on_unknown(worker, event); break;
    }
}
/**
 * 通过名字注册
 * @param {} worker 
 * @param {*} event 
 */
function on_regist(worker, event)
{
    let { name, id } = event

    regist(name, id)
}
/**
 * 反注册名字
 * @param {*} worker 
 * @param {*} event 
 */
function on_unregist(worker, event)
{
    let { name, id } = event

    unregist(name, id)
}

function on_response(worker, event)
{
    const id = event.session
    const rpc = rpcs[id]

    delete rpcs[id]

    if (event.error)
    {
        rpc.reject(event.error)
    }
    else
    {
        rpc.resolve(event.result)
    }
}

/**
 * 要求发给某个ant
 * @param {Object} worker 
 * @param {event} event 
 */
function on_post(worker, event)
{
    const { from, target, name, args } = event

    post(target, from, name, ...args)
}

function on_unknown(event)
{

}
/**
 * 接收到主线程发过来的on_spawn
 * 
 * @param {Object} worker 
 * @param {Object} event event
 */
function on_spawn(worker, event)
{
    try
    {
        let ant = spawn(...event.args)

        response(worker, event.session, ant.id)

        ant.emit("start")           //利用这种方式，拆分掉ant.entry的职责

    }
    catch (error)
    {
        response(worker, event.session, null, error)
    }
}

/**
 * 
 * @param {*} worker 
 * @param {*} event 
 */
function on_destroy(worker, event)
{
    let id = event.id

    destroy(id)
}
//------------------------------------------

/**
 * 
 * @param {Object} worker 
 * @param {int} session 
 * @param {any} result 
 * @param {Error} error 
 */
function response(worker, session, result, error)
{
    send(worker, {
        type: "response",
        session: session,
        result: result,
        error: error
    })
}

/**
 * 作为底层的发送接口
 * @param {Object} worker 
 * @param {Object} event 
 */
function send(worker, event)
{
    if (worker == QUEEN)
    {
        parentPort.postMessage(event)
    }
    else
    {
        worker.port.postMessage(event)
    }
}
/**
 * 底层的远程调用接口
 * @param {*} worker 
 * @param {*} name 
 * @param {*} args 
 * @returns 
 */
function call(worker, name, args)
{
    let id = ++session

    return new Promise(function (resolve, reject)
    {
        rpcs[session] = {
            session: id,
            resolve: resolve,
            reject: reject
        }

        send(worker, {
            type: "call",
            session: id,
            name: name,
            args: args
        })
    })
}

/**
 * 本地创建一个ant
 * @param {String} template 
 * @param {Array} args 
 * @param {Object} meta
 * @returns {Object} ant
 */
function spawn(template, args, meta = {})
{
    if (config.debug)
    {
        console.log("spawn", template, args, meta)
    }

    let ant_id = new_id(meta.id)
    let ant = new_ant(ant_id, template, args, meta)

    let entry = plugins.load(template)

    ants[ant.id] = ant

    entry(ant)

    if (ant.name)
    {
        gregist(ant.name, ant.id)
    }

    return ant
}

/**
 * 在本进程的某个worker中创建一个ant
 * @param {String} template 
 * @param {Array} args 
 * @param {Object} meta 
 * @returns 
 */
function gspawn(...args)
{
    return call(QUEEN, "spawn", args)
}

/**
 * 摧毁一个本地的ant
 * @param {int} target 
 * @returns 
 */
function destroy(target)
{
    if (config.debug)
    {
        console.log("destroy", target)
    }

    let ant = ants[target]

    if (ant == null)
    {
        return
    }

    delete ants[target]

    ant.emit("exit")

    if (ant.name)
    {
        gunregist(ant.name)
    }
}
/**
 * 全局摧毁一个ant
 * @param {int} target 
 */
function gdestroy(target)
{
    let index = worker_index(target)
    let worker = workers[index]

    if (index == workerData.index)
    {
        setImmediate(destroy, target)       //保证和前一个post的顺序
    }
    else
    {
        send(worker, {
            type: "destroy",
            id: target,
        })
    }
}

/**
 * 发送给本地的一个ant的消息
 * @param {int} target ant的id
 * @param {int} from 发送者
 * @param {String} name 
 * @param  {...any} args 
 */
function post(target, from, name, ...args)
{
    if (config.debug)
    {
        console.log("ant post", target, from, name, ...args)
    }

    let ant = ants[target]

    if (typeof target == "string")
    {
        ant = ants[names[target]]
    }

    if (ant)
    {
        ant.emit(name, from, ...args);
    }
    else
    {
        throw new Error("ant not found:" + target)
    }
}

/**
 * 全局发送一个ant的消息
 * @param {int} target ant的id
 * @param {int} from 发送者
 * @param {String} name 
 * @param  {...any} args 
 */
function gpost(target, from, name, ...args)
{
    let index = worker_index(target)
    let worker = workers[index]

    if (index == workerData.index)
    {
        let clone = v8.deserialize(v8.serialize(args))
        post(target, from, name, ...clone)
    }
    else
    {
        send(worker, {
            type: "post",
            from,
            target,
            name,
            args
        })
    }
}

function regist(name, target)
{
    names[name] = target

    if (config.debug)
    {
        console.log(`worker[${workerData.index}]`, "regist", name, target)
    }
}

function gregist(name, target)
{
    regist(name, target)

    BROAD.postMessage({
        type: "regist",
        name: name,
        id: target
    })
}

function search(name)
{
    return names[name]
}

function unregist(name)
{
    delete names[name]
}

function gunregist(name)
{
    unregist(name)

    BROAD.postMessage({
        type: "unregist",
        name: name,
    })

}

function new_ant(id, template, args, meta)
{
    let ant = new EventEmitter()

    ant.id = id
    ant.name = meta.name
    ant.$template = template
    ant.$args = args
    ant.$worker = workerData.index
    ant.$config = workerData.config
    ant.$meta = meta

    ant.spawn = gspawn

    ant.post = (target, name, ...args) =>
    {
        return gpost(target, id, name, ...args)
    }

    ant.destroy = (target) =>
    {
        target = target || id

        return gdestroy(target)
    }

    ant.regist = gregist
    ant.unregist = gunregist
    ant.search = search

    plugins.setup("ant", ant)

    return ant
}