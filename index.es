import React from 'react'
import PropTypes from 'prop-types'

/**
 * 南瓜留船（poi-plugin-nangua-liuchuan）
 *
 * 原理：
 *  1. 查询已有舰娘信息 —— 读取 poi 数据存储（与「舰娘信息」插件同一数据源）：
 *       info.ships    玩家已有舰娘（含当前运 api_lucky[0]、火力 api_karyoku[0]、雷装 api_raisou[0]）
 *       const.$ships  舰娘图鉴数据（名称、基础运、舰种）
 *       const.$stypes 舰种名称
 *       info.fleets   舰队编成（用于识别当前旗舰）
 *  2. 根据「运」值计算「额外捞船」：
 *       额外捞船 = ⌈(目标运 − 当前运) / 除数⌉ × 乘数
 *       默认：目标运 = 51，除数 = 3，乘数 = 2（可在插件设置中修改）
 *  3. 收藏置顶：点击舰娘行首 ★ 收藏，收藏的舰娘固定排在列表最前（📌 标记），
 *     收藏列表保存在 poi 配置中，重启不丢失。
 *  4. 在新窗口打开：poi 的插件设置里自带「Open plugin in new window」开关
 *     （默认值由下方导出的 windowMode 决定），勾选后插件会在独立窗口打开。
 *
 * 兼容性说明（基于 poi 源码 views/services/plugin-manager 与 views/redux/create-store）：
 *  - poi v10+ 要求插件入口具名导出 reactClass（渲染组件）；旧版 poi 使用 default 导出。
 *    本插件两种导出都提供。
 *  - poi v10+ 渲染插件时不传 props，插件需自行获取 store：动态 import('views/create-store')
 *    （poi 的 babel 会把插件文件里的动态 import 转成 require，经 module-path 补丁解析）。
 *  - 旧版 poi 会传入 props.store / props.config / props.setConfig，本插件优先使用。
 *  - 收藏与设置：旧版用 props.setConfig 持久化；新版用 poi 配置（remote.require('./lib/config')），
 *    路径为 poi.plugin.nangua-liuchuan.*；都不行时退回 localStorage。
 */

// ==================== 默认配置 ====================

const DEFAULT_CONFIG = {
  targetLuck: 51, // 目标运值（默认提升到 51）
  divisor: 3,     // 公式除数
  multiplier: 2,  // 公式乘数
  levelCap: 0,    // 留船等级上限（0 = 不筛选；低于该等级的舰全部筛除，不视为主力舰）
}

const CONFIG_PREFIX = 'poi.plugin.nangua-liuchuan' // poi 配置路径前缀
const LS_KEY = 'poi-plugin-nangua-liuchuan-config' // localStorage 兜底键

const COLORS = {
  card: '#2a2e33',
  cardBorder: '#3d434b',
  text: '#d8dee6',
  dim: '#8b949e',
  accent: '#ffd75e',
  warn: '#ff9d5c',
  rowAlt: 'rgba(255,255,255,0.035)',
}

// ==================== poi 环境辅助 ====================

// poi 主窗口/插件窗口都会注入 window.POI_VERSION（见 poi views/env-parts/const）
const IN_POI = typeof window !== 'undefined' && 'POI_VERSION' in window

// 与 poi-plugin-quest-2 相同的取 store 方式：动态 import('views/create-store')
// （poi 的 babel.config.js 会把插件目录下的动态 import 转成 require）
const importFromPoi = path => {
  if (!IN_POI) {
    return new Promise(() => {}) // 不在 poi 环境则永不 resolve
  }
  return import(path)
}

// 获取 poi 的 config（主进程单例，remote.require('./lib/config')）
function getPoiConfig() {
  try {
    const remote = typeof window !== 'undefined' ? window.remote : undefined
    if (remote && typeof remote.require === 'function') {
      return remote.require('./lib/config')
    }
  } catch (e) {
    /* ignore */
  }
  return null
}

// ==================== 计算函数 ====================

// 额外捞船 = ⌈(目标运 − 当前运) / 除数⌉ × 乘数
export function calcExtraFarming(luck, cfg) {
  const c = { ...DEFAULT_CONFIG, ...(cfg || {}) }
  const missing = c.targetLuck - luck
  if (missing <= 0) return 0
  return Math.ceil(missing / c.divisor) * c.multiplier
}

// 估算提升到目标运所需的まるゆ数量（每只平均 +1.6 运）
export function calcMaruyu(luck, cfg) {
  const c = { ...DEFAULT_CONFIG, ...(cfg || {}) }
  const missing = c.targetLuck - luck
  if (missing <= 0) return 0
  return Math.ceil(missing / 1.6)
}

// ==================== 插件主体 ====================

class PumpkinKeepShip extends React.Component {
  static propTypes = {
    store: PropTypes.object,
    config: PropTypes.object,
    setConfig: PropTypes.func,
    poi: PropTypes.object,
  }

  constructor(props) {
    super(props)
    // 旧版 poi 传入 setConfig → 走 props 配置；新版 → 走 poi 配置/localStorage
    this._legacyMode = typeof props.setConfig === 'function'
    this._poiStore = null
    this._sig = ''
    this._unsub = null
    this._timer = null
    this.state = {
      ready: false,
      ships: [],
      sortKey: 'luck', // 当前排序列
      sortDir: 'asc', // 'asc' | 'desc'
      stypeFilter: '', // 舰种筛选（空 = 全部）
      localConfig: null, // 新版配置（含收藏），无持久化时的内存兜底
      externalShips: null, // 其它插件（如舰娘信息）通过 plugin.message 推送的数据
      error: null,
    }
    this.handlePluginMessage = this.handlePluginMessage.bind(this)
    this.handleSort = this.handleSort.bind(this)
  }

  componentDidMount() {
    // 载入持久化配置（新版 poi 无 props.config）
    if (!this._legacyMode) {
      const saved = this.loadPersistedConfig()
      if (saved) this.setState({ localConfig: saved })
    }

    // 监听数据变化：旧版用 props.store，新版动态获取 poi 的 store
    const s = this.props.store
    if (s && typeof s.subscribe === 'function') {
      this._unsub = s.subscribe(() => this.refresh())
    } else {
      importFromPoi('views/create-store')
        .then(mod => {
          const st = (mod && (mod.store || mod.default)) || null
          if (st && typeof st.subscribe === 'function') {
            this._poiStore = st
            this._unsub = st.subscribe(() => this.refresh())
            this.refresh()
          }
        })
        .catch(err => console.warn('南瓜留船：获取 poi store 失败', err))
    }

    this.refresh()
    // 兜底定时刷新（数据尚未就绪 / store 事件未触发 / 仅 window.getStore 可用时）
    this._timer = setInterval(() => this.refresh(), 5000)

    // 可选：接收其它插件（如「舰娘信息」）通过 plugin.message 广播的舰娘数据
    window.addEventListener('plugin.message', this.handlePluginMessage)
  }

  componentWillUnmount() {
    if (this._unsub) this._unsub()
    if (this._timer) clearInterval(this._timer)
    window.removeEventListener('plugin.message', this.handlePluginMessage)
  }

  componentDidCatch(error) {
    console.error(error)
    this.setState({ error: String((error && error.stack) || error) })
  }

  // ---------------- 配置 ----------------

  loadPersistedConfig() {
    let saved = null
    try {
      const c = getPoiConfig()
      if (c && typeof c.get === 'function') {
        const v = c.get(CONFIG_PREFIX)
        if (v && typeof v === 'object') saved = v
      }
    } catch (e) {
      /* ignore */
    }
    if (!saved) {
      try {
        saved = JSON.parse(localStorage.getItem(LS_KEY) || 'null')
      } catch (e) {
        saved = null
      }
    }
    return saved && typeof saved === 'object' ? saved : null
  }

  getConfig() {
    if (this._legacyMode) {
      return { ...DEFAULT_CONFIG, ...(this.props.config || {}), ...(this.state.localConfig || {}) }
    }
    return { ...DEFAULT_CONFIG, ...(this.state.localConfig || {}) }
  }

  setConfig(patch) {
    if (this._legacyMode && typeof this.props.setConfig === 'function') {
      // 旧版 poi：setConfig 会持久化插件配置
      this.props.setConfig({ ...(this.props.config || {}), ...patch })
      return
    }
    const next = { ...this.getConfig(), ...patch }
    this.setState({ localConfig: next })
    // 新版 poi：写入 poi 配置（remote config，持久化）；失败则退回 localStorage
    let persisted = false
    try {
      const c = getPoiConfig()
      if (c && typeof c.set === 'function') {
        c.set(CONFIG_PREFIX, next)
        persisted = true
      }
    } catch (e) {
      persisted = false
    }
    if (!persisted) {
      try {
        localStorage.setItem(LS_KEY, JSON.stringify(next))
      } catch (e) {
        /* ignore */
      }
    }
  }

  getFavorites() {
    const favs = this.getConfig().favorites
    return Array.isArray(favs) ? favs : []
  }

  // ---------------- 数据刷新 ----------------

  refresh() {
    // 数据源优先级：props.store（旧版 poi）→ 动态获取的 store（新版 poi）→ window.getStore（兜底）
    let store = this._poiStore || this.props.store || null
    let state = null
    if (store && typeof store.getState === 'function') {
      try {
        state = store.getState()
      } catch (e) {
        state = null
      }
    }
    if (!state && typeof window !== 'undefined' && typeof window.getStore === 'function') {
      try {
        state = window.getStore()
      } catch (e) {
        state = null
      }
    }
    if (!state) {
      this.setState({ ready: false })
      return
    }
    const info = state.info
    const consts = state.const
    const shipsMap = info && info.ships
    const masterShips = consts && consts.$ships
    // 新版 poi 键名为 $shipTypes，旧版为 $stypes，两者兼容
    const stypeNames = (consts && (consts.$shipTypes || consts.$stypes)) || null

    if (!shipsMap || !masterShips) {
      this.setState({ ready: false })
      return
    }

    // 舰线分组：同一艘舰的改造链（api_aftershipid 一路改到最终形态）视为同一“舰线”。
    // 「已捞」按舰线统计，这样長波/長波改/長波改二 等不同改造形态也能合并计算。
    const lineKey = {}
    const masterIds = Object.keys(masterShips)
    for (let i = 0; i < masterIds.length; i++) {
      const id = masterIds[i]
      let cur = id
      const seen = {}
      let guard = 0
      while (guard++ < 50) {
        const m = masterShips[cur]
        if (!m) break
        const next = m.api_aftershipid
        if (next === undefined || next === null || next === 0 || next === '0' || next === '') break
        const nextStr = String(next)
        if (seen[nextStr]) break
        seen[nextStr] = true
        cur = nextStr
      }
      lineKey[id] = cur
    }

    // 轻量签名：仅当相关数据真正变化时才重建列表，避免无意义重渲染
    const sig =
      Object.keys(shipsMap).length +
      '|' +
      masterIds.length +
      '|' +
      Object.keys(shipsMap)
        .slice(0, 600)
        .map(id => {
          const s = shipsMap[id]
          return (
            s.api_ship_id +
            ':' +
            s.api_lv +
            ':' +
            (s.api_lucky ? s.api_lucky[0] : s.api_luck ? s.api_luck[0] : -1) +
            ':' +
            (s.api_karyoku ? s.api_karyoku[0] : -1) +
            ':' +
            (s.api_raisou ? s.api_raisou[0] : -1)
          )
        })
        .join(',')
    if (sig === this._sig && this.state.ready) return
    this._sig = sig

    // 所有已有舰娘
    const ships = Object.keys(shipsMap).map(id => {
      const s = shipsMap[id]
      const m = masterShips[s.api_ship_id] || {}
      const st = (stypeNames && stypeNames[m.api_stype]) || {}
      const luck = s.api_lucky ? s.api_lucky[0] : s.api_luck ? s.api_luck[0] : 0
      const firepower = s.api_karyoku ? s.api_karyoku[0] : 0 // 火力（含改修/近代化加成）
      const torpedo = s.api_raisou ? s.api_raisou[0] : 0 // 雷装
      return {
        id: s.api_id,
        shipId: s.api_ship_id,
        name: m.api_name || '舰' + s.api_ship_id,
        stype: st.api_name || (m.api_stype != null ? '类型' + m.api_stype : '-'),
        lv: s.api_lv || 0,
        luck,
        firepower,
        torpedo,
        locked: s.api_locked === 1, // 是否已上锁（上锁 = 已捞）
      }
    })

    this.setState({ ready: true, ships, lineKey })
  }

  handlePluginMessage(e) {
    const detail = e && e.detail
    if (!detail || !detail.type || !detail.body) return
    // 接受「舰娘信息」等插件广播的舰娘数据（数组或 { ships: [...] }）
    if (detail.type === 'nangua-liuchuan.ships' || detail.type === 'ship-info.ships') {
      const list = Array.isArray(detail.body) ? detail.body : detail.body.ships || detail.body.list
      if (Array.isArray(list) && list.length) {
        this.setState({ externalShips: list })
      }
    }
  }

  // ---------------- 交互 ----------------

  toggleFavorite(id) {
    const favs = this.getFavorites().slice()
    const idx = favs.indexOf(id)
    if (idx >= 0) favs.splice(idx, 1)
    else favs.push(id)
    this.setConfig({ favorites: favs })
  }

  changeNumber(key, value) {
    const num = parseInt(value, 10)
    if (!isNaN(num)) {
      this.setConfig({ [key]: num })
      this.refresh() // 目标运变化后立刻重算
    }
  }

  resetConfig() {
    this.setConfig({
      targetLuck: DEFAULT_CONFIG.targetLuck,
      divisor: DEFAULT_CONFIG.divisor,
      multiplier: DEFAULT_CONFIG.multiplier,
      levelCap: DEFAULT_CONFIG.levelCap,
    })
  }

  // 点击表头排序：同列再点切换升/降序
  handleSort(key) {
    this.setState(s => {
      if (s.sortKey === key) {
        return { sortDir: s.sortDir === 'asc' ? 'desc' : 'asc' }
      }
      return { sortKey: key, sortDir: 'asc' }
    })
  }

  // ---------------- 渲染 ----------------

  render() {
    const cfg = this.getConfig()
    const favorites = this.getFavorites()
    const { ready, ships, sortKey, sortDir, stypeFilter, externalShips, error } = this.state

    if (error) {
      return (
        <div style={styles.wrap}>
          <div style={styles.title}>🎃 南瓜留船</div>
          <div style={styles.errorBox}>
            <b>插件运行出错：</b>
            <br />
            {error}
            <br />
            <br />
            请把上面的错误信息复制给插件作者，或在 poi 的插件设置里点「Reload」重载。
          </div>
        </div>
      )
    }

    const levelCap = cfg.levelCap || 0
    // 舰线：同一条改造链（如長波/長波改/長波改二）归为同一舰线
    const lineKey = this.state.lineKey || {}
    const getLine = shipId => lineKey[String(shipId)] || String(shipId)
    // 每行「已捞」= 该舰线中「上锁且等级不足留船等级上限」的舰数（按舰线统计，不是总数）
    const obtainedByShip = {}
    if (levelCap > 0) {
      ships.forEach(s => {
        if (s.lv < levelCap && s.locked) {
          const k = getLine(s.shipId)
          obtainedByShip[k] = (obtainedByShip[k] || 0) + 1
        }
      })
    }
    const allShips = (externalShips && externalShips.length ? externalShips : ships)
      .filter(s => s.luck < cfg.targetLuck)
      .map(s => {
        const missing = Math.max(0, cfg.targetLuck - s.luck)
        const firepower = s.firepower || 0
        const torpedo = s.torpedo || 0
        const locked = !!s.locked
        const extra = calcExtraFarming(s.luck, cfg)
        const obtained = obtainedByShip[getLine(s.shipId)] || 0
        // 剩余捞船 = ⌈剩余运/3⌉×2（基数本身为偶数） − 已捞（本舰线），小于 0 按 0 计
        const remaining = Math.max(0, extra - obtained)
        return {
          ...s,
          fav: favorites.indexOf(s.id) >= 0,
          missing,
          extra,
          remaining,
          obtained,
          maruyu: calcMaruyu(s.luck, cfg),
          firepower,
          torpedo,
          total: firepower + torpedo,
          locked,
        }
      })

    // 舰种筛选项（在应用筛选前统计，保证选项完整）
    const stypeOptions = [...new Set(allShips.map(s => s.stype).filter(Boolean))].sort((a, b) =>
      a.localeCompare(b, 'ja'),
    )
    // 按舰种筛选
    let list = allShips.filter(s => !stypeFilter || s.stype === stypeFilter)

    // 留船等级上限：低于上限的舰全部筛除（不视为主力舰，等级不足的全部移除）
    if (levelCap > 0) {
      list = list.filter(s => s.lv >= levelCap)
    }

    // 收藏固定置顶；其余按表头点击的列排序
    list.sort((a, b) => {
      if (a.fav !== b.fav) return a.fav ? -1 : 1
      const va = a[sortKey]
      const vb = b[sortKey]
      let r = 0
      if (typeof va === 'number' && typeof vb === 'number') {
        r = va - vb
      } else {
        r = String(va == null ? '' : va).localeCompare(String(vb == null ? '' : vb), 'ja')
      }
      if (r === 0) r = b.lv - a.lv
      return sortDir === 'asc' ? r : -r
    })

    // 可排序表头
    const th = (label, key) => (
      <th style={styles.th} onClick={() => this.handleSort(key)} title="点击排序">
        {label}
        {sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
      </th>
    )

    return (
      <div style={styles.wrap}>
        {/* 标题与公式说明 */}
        <div style={styles.header}>
          <span style={styles.title}>🎃 南瓜留船</span>
          <span style={styles.formula}>
            额外捞船 = ⌈({cfg.targetLuck} − 当前运) ÷ {cfg.divisor}⌉ × {cfg.multiplier}
          </span>
        </div>

        {/* 设置区 */}
        <div style={styles.settings}>
          <label style={styles.label}>目标运</label>
          <input
            type="number"
            style={styles.input}
            value={cfg.targetLuck}
            min={1}
            max={200}
            onChange={e => this.changeNumber('targetLuck', e.target.value)}
          />
          <label style={styles.label}>除数</label>
          <input
            type="number"
            style={styles.input}
            value={cfg.divisor}
            min={1}
            max={20}
            onChange={e => this.changeNumber('divisor', e.target.value)}
          />
          <label style={styles.label}>乘数</label>
          <input
            type="number"
            style={styles.input}
            value={cfg.multiplier}
            min={1}
            max={20}
            onChange={e => this.changeNumber('multiplier', e.target.value)}
          />
          <button style={styles.btn} onClick={() => this.resetConfig()}>
            恢复默认
          </button>
          <label style={styles.label}>留船等级上限</label>
          <input
            type="number"
            style={styles.input}
            value={cfg.levelCap}
            min={0}
            max={200}
            title="低于该等级的舰全部筛除（不视为主力舰）；0 = 不筛选"
            onChange={e => this.changeNumber('levelCap', e.target.value)}
          />
          <span style={styles.dim}>点击表头可排序</span>
        </div>

        {!ready ? (
          <div style={styles.empty}>
            游戏数据尚未加载……<br />
            请先进入游戏母港，等待 poi 同步舰娘数据（约数秒后自动刷新）。
          </div>
        ) : (
          <div>
            {/* 列表 */}
            <div style={styles.toolbar}>
              <span style={styles.dim}>
                共 {list.length} 艘{levelCap > 0 ? `主力舰（等级 ≥ ${levelCap}）` : '舰娘'}「运」值低于{' '}
                {cfg.targetLuck}
                {favorites.length ? `（已收藏 ${favorites.length} 艘，置顶显示）` : ''}
              </span>
              <span style={styles.filterBox}>
                <label style={styles.filterLabel}>舰种筛选</label>
                <select
                  style={styles.select}
                  value={stypeFilter}
                  onChange={e => this.setState({ stypeFilter: e.target.value })}
                >
                  <option value="">全部舰种</option>
                  {stypeOptions.map(t => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </span>
            </div>

            {list.length === 0 ? (
              <div style={styles.empty}>
                🎉 没有需要剩余捞船的舰娘（「运」值都 ≥ {cfg.targetLuck}，或等级不足被筛除）！
              </div>
            ) : (
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={styles.th}></th>
                    {th('舰种', 'stype')}
                    {th('舰娘', 'name')}
                    {th('Lv', 'lv')}
                    {th('火力', 'firepower')}
                    {th('雷装', 'torpedo')}
                    {th('火力+雷装', 'total')}
                    {th('当前运', 'luck')}
                    {th('剩余运', 'missing')}
                    <th
                      style={styles.th}
                      title="该舰（同舰线：含長波/長波改/長波改二等各改造形态）中上锁且等级不足留船等级上限的舰数（每行对应本船的已捞数）"
                    >
                      已捞
                    </th>
                    {th('剩余捞船', 'remaining')}
                    {th('まるゆ(估)', 'maruyu')}
                  </tr>
                </thead>
                <tbody>
                  {list.map((s, i) => {
                    return (
                      <tr
                        key={s.id != null ? s.id : i + '-' + s.shipId}
                        style={i % 2 ? { backgroundColor: COLORS.rowAlt } : null}
                      >
                        <td style={styles.td}>
                          <button
                            style={s.fav ? styles.starOn : styles.starOff}
                            title={s.fav ? '取消收藏' : '收藏置顶'}
                            onClick={() => this.toggleFavorite(s.id)}
                          >
                            {s.fav ? '★' : '☆'}
                          </button>
                        </td>
                        <td style={styles.td}>{s.stype}</td>
                        <td style={styles.td}>
                          {s.name}
                          {s.fav ? ' 📌' : ''}
                        </td>
                        <td style={styles.td}>{s.lv}</td>
                        <td style={styles.td}>{s.firepower}</td>
                        <td style={styles.td}>{s.torpedo}</td>
                        <td style={styles.td}>
                          <b>{s.total}</b>
                        </td>
                        <td style={styles.td}>
                          <b>{s.luck}</b>
                        </td>
                        <td style={styles.td}>{s.missing}</td>
                        <td style={styles.td}>
                          <b
                            style={s.obtained > 0 ? { color: COLORS.accent } : null}
                            title="该舰（同舰线：含各改造形态）上锁且等级不足留船等级上限的舰数"
                          >
                            {s.obtained}
                          </b>
                        </td>
                        <td style={styles.td}>
                          {s.remaining > 0 ? (
                            <b style={{ color: COLORS.warn }}>{s.remaining}</b>
                          ) : (
                            <span title="剩余捞船为 0，已完成">✅</span>
                          )}
                        </td>
                        <td style={styles.td}>{s.maruyu}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    )
  }
}

// ==================== 插件导出（兼容新旧 poi） ====================

/**
 * 是否默认在新窗口打开（false = 默认在 poi 主窗口标签页内打开）。
 * poi 会在插件设置里自动显示「Open plugin in new window」开关，
 * 其默认值即此处的 windowMode（见 poi views/components/settings/plugin/plugin-item.tsx）。
 */
export const windowMode = false

/** poi v10+ 通过具名导出 reactClass 渲染插件主界面 */
export const reactClass = PumpkinKeepShip

/** 旧版 poi（v9 及更早）通过 default 导出渲染插件 */
export default PumpkinKeepShip

// ==================== 样式 ====================

const styles = {
  wrap: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    height: '100%',
    minHeight: 0,
    overflow: 'auto',
    padding: '10px 14px',
    fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif',
    color: COLORS.text,
    fontSize: 13,
  },
  header: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    marginBottom: 8,
  },
  title: {
    fontSize: 17,
    fontWeight: 700,
  },
  formula: {
    color: COLORS.dim,
    fontSize: 12,
  },
  settings: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
    padding: '6px 10px',
    backgroundColor: COLORS.card,
    border: '1px solid ' + COLORS.cardBorder,
    borderRadius: 4,
    marginBottom: 10,
  },
  label: {
    color: COLORS.dim,
    marginLeft: 6,
  },
  input: {
    width: 56,
    padding: '2px 4px',
    backgroundColor: '#1c1f24',
    color: COLORS.text,
    border: '1px solid ' + COLORS.cardBorder,
    borderRadius: 3,
    textAlign: 'center',
  },
  btn: {
    marginLeft: 8,
    padding: '3px 10px',
    backgroundColor: '#3a4048',
    color: COLORS.text,
    border: '1px solid ' + COLORS.cardBorder,
    borderRadius: 3,
    cursor: 'pointer',
  },
  card: {
    padding: '8px 12px',
    backgroundColor: COLORS.card,
    border: '1px solid ' + COLORS.cardBorder,
    borderRadius: 4,
    marginBottom: 10,
  },
  cardRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    padding: '2px 0',
  },
  cardTitle: {
    fontWeight: 700,
  },
  bigLabel: {
    fontSize: 12,
    color: COLORS.dim,
  },
  bigValue: {
    fontSize: 24,
    fontWeight: 800,
    color: COLORS.accent,
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 6,
  },
  filterBox: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  filterLabel: {
    color: COLORS.dim,
    fontSize: 12,
  },
  select: {
    padding: '2px 6px',
    backgroundColor: '#1c1f24',
    color: COLORS.text,
    border: '1px solid ' + COLORS.cardBorder,
    borderRadius: 3,
    maxWidth: 160,
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
  },
  th: {
    textAlign: 'left',
    padding: '4px 8px',
    color: COLORS.dim,
    borderBottom: '1px solid ' + COLORS.cardBorder,
    fontWeight: 600,
    whiteSpace: 'nowrap',
    cursor: 'pointer',
    userSelect: 'none',
  },
  td: {
    padding: '3px 8px',
    borderBottom: '1px solid rgba(255,255,255,0.05)',
    whiteSpace: 'nowrap',
  },
  starBtn: {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    fontSize: 16,
    color: COLORS.accent,
    padding: 0,
  },
  starOn: {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    fontSize: 14,
    color: COLORS.accent,
    padding: 0,
  },
  starOff: {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    fontSize: 14,
    color: COLORS.dim,
    padding: 0,
  },
  empty: {
    padding: '24px 12px',
    textAlign: 'center',
    color: COLORS.dim,
    lineHeight: 1.8,
  },
  errorBox: {
    marginTop: 10,
    padding: '10px 12px',
    backgroundColor: '#3a2222',
    border: '1px solid #7a3b3b',
    borderRadius: 4,
    color: '#ffb3b3',
    lineHeight: 1.6,
    wordBreak: 'break-all',
  },
}
