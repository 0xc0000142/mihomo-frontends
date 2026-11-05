function fail(message) { print "不支持的 YAML: " message > "/dev/stderr"; failed=1; exit 1 }
function trim(text) { sub(/^[ ]+/,"",text); sub(/[ ]+$/,"",text); return text }
function indent(text) { match(text,/[^ ]/); return RSTART-1 }
function meaningful(text) { return text !~ /^[ ]*(#.*)?$/ }
function key(text) { sub(/:.*/,"",text); return trim(text) }
function value(text) { sub(/^[^:]+:[ ]*/,"",text); sub(/[ ]+#.*/,"",text); return trim(text) }
function pad(count, output) { output=""; while (count-->0) output=output " "; return output }
function scalar(text) {
    if (text ~ /^"[a-z_]+"$/ || text ~ /^'[a-z_]+'$/) return substr(text,2,length(text)-2)
    return text
}
function role_output(role, start, finish, property, number, text, depth, skip, field) {
    print pad(property) role ":"
    if (role=="local") {
        print pad(property+2) "dns-mode: respect_policy"
        printf "%sexclude-package: [",pad(property+2)
        for (number=1; number<=package_count; number++) printf "%s\"%s\"",(number>1?", ":""),packages[number]
        print "]"
    } else {
        printf "%sinterface: [",pad(property+2)
        for (number=1; number<=interface_count; number++) printf "%s\"%s\"",(number>1?", ":""),interface_names[number]
        print "]"
    }
    skip=0
    for (number=start+1; number<=finish && start; number++) {
        text=lines[number]
        if (!meaningful(text)) { print text; continue }
        depth=indent(text)
        if (depth==property+2) {
            field=key(trim(text))
            skip=(field=="enable" || field=="enabled" || (role=="local" && (field=="dns-mode" || field=="exclude-package")) || (role=="shared" && field=="interface"))
        }
        if (!skip) print text
    }
}
{
    sub(/\r$/,"")
    lines[NR]=$0
}
END {
    if (failed) exit 1
    for (number=1; number<=NR; number++) {
        text=lines[number]
        if (text ~ /^\t/ || text ~ /^ +\t/) fail("禁止使用 tab 缩进")
        if (text ~ /^(---|\.\.\.|%)/) fail("不支持多文档或 YAML 指令")
        if (text ~ /^(<<:|["'](listeners|<<)["']:|[?{[])/) fail("根 listeners 必须为显式普通键，不能继承")
        if (text ~ /^listeners:/) {
            if (root) fail("重复 listeners")
            if (value(text)!="") fail("listeners 必须是块列表")
            root=number
        }
    }
    if (!root) fail("需要一个显式 eBPF listener")
    finish=NR
    for (number=root+1; number<=NR; number++) {
        text=lines[number]
        if (!meaningful(text)) continue
        depth=indent(text)
        if (depth==0 && text !~ /^- /) { finish=number-1; break }
        if (!start) {
            if (text !~ /^[ ]*- [a-zA-Z0-9_-]+:/) fail("listener 必须是块映射，不能是 flow/alias")
            start=number
            sequence=depth
            property=depth+2
        } else if (depth==sequence && text ~ /^[ ]*- /) fail("当前策略仅支持一个 listener，请合并或移除其他 listeners")
    }
    if (!start) fail("listeners 为空")
    section=""
    for (number=start; number<=finish; number++) {
        text=lines[number]
        if (!meaningful(text)) continue
        depth=indent(text)
        text=trim(text)
        if (number==start) { sub(/^- /,"",text); depth=property }
        if (text ~ /(^|[ :,[{])[*&!][^ ]/ || text ~ /^<</ || text ~ /:[ ]*[|>]/) fail("listener 不支持锚点、别名、tag、合并键或多行 scalar")
        if (depth==property || depth==property+2) {
            if (text !~ /^[a-zA-Z0-9_-]+:/ && text !~ /^- /) fail("listener 字段必须使用普通键")
        }
        if (depth==property) {
            field=key(text)
            if (seen["listener",field]++) fail("重复 listener 字段 " field)
            section=""
            if (field=="type") listener_type=scalar(value(text))
            if (field=="mode") mode_line=number
            if (field=="local" || field=="shared") {
                if (value(text)!="" && value(text)!="{}") fail(field " 必须是块映射或 {}")
                if (number==start) fail("listener 首字段不能是 local/shared")
                section=field
                role_start[field]=number
            }
        } else if (depth<property) fail("listener 缩进错误")
        else if (section!="") {
            if (depth==property+2 && text !~ /^- /) {
                field=key(text)
                if (seen[section,field]++) fail("重复 " section "." field)
            } else if (text !~ /^- /) fail("role 只支持普通字段及逐行 scalar 列表")
            role_end[section]=number
        }
    }
    if (listener_type!="ebpf") fail("需要 type: ebpf")
    while ((getline package_line < packages_file)>0) {
        if (package_line!="") {
            if (package_line !~ /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)+$/) fail("包名格式无效")
            packages[++package_count]=package_line
        }
    }
    close(packages_file)
    interface_count=split(interfaces,interface_names,",")
    for (number=1; number<=interface_count; number++) {
        if (interface_names[number] !~ /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/ || length(interface_names[number])>15) fail("接口名称无效")
    }
    for (number=1; number<=NR; number++) {
        if (number==start) {
            print lines[number]
            print pad(property) "mode: " (tethering==1?"hybrid":"local")
            if (mode_line==start) fail("listener 首字段不能是 mode")
            role_output("local",role_start["local"],role_end["local"],property)
            role_output("shared",role_start["shared"],role_end["shared"],property)
        } else if (number>start && number<=finish) {
            if (number==mode_line) continue
            if (number==role_start["local"] || number==role_start["shared"]) {
                role=(number==role_start["local"]?"local":"shared")
                if (role_end[role]>number) number=role_end[role]
                continue
            }
            print lines[number]
        } else print lines[number]
    }
}
