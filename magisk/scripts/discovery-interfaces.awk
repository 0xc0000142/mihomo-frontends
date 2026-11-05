scope=="upstream" { upstream[$1]=1 }
scope=="interfaces" {
    names[++count]=$1
    kinds[$1]=$2
    states[$1]=$3
    suggestions[$1]=$4
}
END {
    printf "["
    for (position=1; position<=count; position++) {
        interface_name=names[position]
        is_upstream=(interface_name in upstream)
        printf "%s{\"name\":\"%s\",\"kind\":\"%s\",\"present\":true,\"state\":\"%s\",\"upstream\":%s,\"suggested\":%s}", \
            (position>1?",":""),interface_name,kinds[interface_name],states[interface_name], \
            (is_upstream?"true":"false"),(suggestions[interface_name] && !is_upstream?"true":"false")
    }
    printf "]"
}
