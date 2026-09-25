local logger     = require("logger")
local millennium = require("millennium")

-- Load the RPC functions defensively. If anything in rpc_functions.lua throws at
-- load time, we must NOT let it stop us from calling millennium.ready() below —
-- otherwise Millennium keeps waiting on the backend and Steam's UI never appears.
local ok_rpc, rpc_err = pcall(require, "rpc_functions")
if not ok_rpc then
    pcall(function() logger:error("rpc_functions failed to load: " .. tostring(rpc_err)) end)
end

local function on_load()
    -- Signal ready FIRST, unconditionally. A plugin problem must never be able to
    -- block the Steam client from starting. Everything after this is best-effort.
    local ok_ready = pcall(function() millennium.ready() end)
    pcall(function()
        local ver = "?"
        pcall(function() ver = millennium.version() end)
        logger:info("ONE GAMERS Activation loaded (Millennium " .. tostring(ver) ..
                    ", ready=" .. tostring(ok_ready) .. ", rpc=" .. tostring(ok_rpc) .. ")")
    end)
end

local function on_unload()
    pcall(function() logger:info("ONE GAMERS Activation unloaded") end)
end

return {
    on_load = on_load,
    on_unload = on_unload,
}
